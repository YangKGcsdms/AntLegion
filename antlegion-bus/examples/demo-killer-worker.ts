/**
 * demo-killer-worker — one independent agent process for the killer demo.
 *
 * Each worker pretends to come from a different agent framework (LangGraph,
 * CrewAI, Claude-Code-style, plain bash script). They share NOTHING: no
 * locks, no leader, no messages between agents. Every worker independently
 * mirrors the fact stream (incremental `since` cursor), folds task lifecycles
 * locally, and races to claim open tasks. Exactly-once falls out of the
 * total order: the lowest-seq live claim wins (PROTOCOL.md §3.1).
 *
 * Modes:
 *   racer  — claim first open task, "work", resolve (guarded: re-fold before
 *            committing so an expired claim never produces a duplicate done).
 *   victim — holds up to --batch claims at once and drains them slowly, so a
 *            mid-run SIGKILL strands real claims that the swarm must re-dispatch.
 *
 * This file also exports foldTasks(), the per-task ownership fold shared with
 * examples/demo-killer.ts (mirrors src/fold.ts semantics: claim/resolve/
 * release/tombstone with recv-anchored deterministic expiry).
 *
 * Run (normally spawned by demo-killer.ts):
 *   npx tsx examples/demo-killer-worker.ts --bus http://localhost:PORT \
 *     --author langgraph-1 --total 400 --delta 3 --mode racer --work-ms 40
 */

import { fileURLToPath } from "node:url";
import { ClientV2, httpTransport } from "../src/client.js";
import type { Fact } from "../src/types.js";
import { RESERVED } from "../src/types.js";

// ───────────────────── shared fold (mirrors src/fold.ts §3.1) ─────────────────────

export interface TaskView {
  id: string;                 // task.todo fact id
  i: number;                  // payload.i
  state: "open" | "claimed" | "resolved" | "dead";
  owner: string | null;       // current/terminal owner (lowest-seq live claim)
  claims: number;             // total _.claim facts targeting this task
  claimAuthors: Set<string>;  // distinct authors that ever claimed it
  firstClaimer: string | null;// author of the lowest-seq claim ever
  effectiveResolves: number;  // resolves by the owner at the time (fold-terminal)
  doneChildren: number;       // task.done child facts (refs.parent = task)
}

interface ActiveClaim { author: string; seq: number; recv: number }

/**
 * Fold every task's lifecycle from the raw fact stream in one pass.
 * Semantics identical to src/fold.ts `ownership()`:
 *   - deterministic expiry: a claim dies once a later fact's recv passes recv+Δ
 *   - resolve only counts when authored by the current lowest-seq live claim
 *   - release drops the author's claims; tombstone is terminal `dead`
 *   - a trailing live claim is checked against wall-clock `now`
 */
export function foldTasks(facts: readonly Fact[], now: number, delta: number): Map<string, TaskView> {
  const tasks = new Map<string, TaskView>();
  const rel = new Map<string, Fact[]>();

  for (const f of facts) {
    if (f.type === "task.todo") {
      tasks.set(f.id, {
        id: f.id, i: Number((f.payload as { i?: number }).i ?? -1),
        state: "open", owner: null, claims: 0, claimAuthors: new Set(),
        firstClaimer: null, effectiveResolves: 0, doneChildren: 0,
      });
    }
    const target = f.refs.claim_of ?? f.refs.resolves ?? f.refs.release_of ??
      (f.type === RESERVED.TOMBSTONE ? f.refs.tombstones : undefined);
    if (target) {
      const arr = rel.get(target) ?? [];
      arr.push(f);
      rel.set(target, arr);
    }
    if (f.type === "task.done" && f.refs.parent) {
      // counted below once tasks exist; stash on rel map via a synthetic key
      const arr = rel.get(`done:${f.refs.parent}`) ?? [];
      arr.push(f);
      rel.set(`done:${f.refs.parent}`, arr);
    }
  }

  for (const [id, view] of tasks) {
    view.doneChildren = (rel.get(`done:${id}`) ?? []).length;
    const events = (rel.get(id) ?? []).sort((a, b) => a.seq - b.seq);
    let active: ActiveClaim[] = [];
    let terminal = false;
    for (const f of events) {
      if (f.type === RESERVED.TOMBSTONE) { view.state = "dead"; view.owner = null; terminal = true; break; }
      active = active.filter((c) => f.recv <= c.recv + delta);
      if (f.refs.claim_of === id) {
        active.push({ author: f.author, seq: f.seq, recv: f.recv });
        view.claims++;
        view.claimAuthors.add(f.author);
        if (!view.firstClaimer) view.firstClaimer = f.author;
      } else if (f.refs.release_of === id) {
        active = active.filter((c) => c.author !== f.author);
      } else if (f.refs.resolves === id) {
        const winner = active.length ? [...active].sort((a, b) => a.seq - b.seq)[0].author : null;
        if (winner !== null && f.author === winner) {
          view.state = "resolved"; view.owner = winner; view.effectiveResolves++;
          terminal = true;
          break; // resolved is terminal — fold.ts returns here
        }
      }
    }
    if (!terminal) {
      active = active.filter((c) => now <= c.recv + delta);
      if (active.length) {
        view.state = "claimed";
        view.owner = [...active].sort((a, b) => a.seq - b.seq)[0].author;
      }
    }
  }
  return tasks;
}

// ───────────────────────────── worker entry point ─────────────────────────────

function arg(flag: string, dflt?: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : (dflt ?? "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function workerMain(): Promise<number> {
  const bus = arg("--bus");
  const author = arg("--author", "anon");
  const total = parseInt(arg("--total", "0"), 10);
  const delta = parseFloat(arg("--delta", "600"));
  const mode = arg("--mode", "racer") as "racer" | "victim";
  const batch = parseInt(arg("--batch", "8"), 10);
  const workMs = parseInt(arg("--work-ms", "40"), 10);
  const maxMs = parseInt(arg("--max-ms", "120000"), 10);

  const client = new ClientV2(httpTransport(bus), author, { claimTimeout: delta });
  const mirror: Fact[] = [];
  let cursor = 0;

  const pull = async (): Promise<void> => {
    for (;;) {
      const chunk = await client.query({ since: cursor, limit: 1000 });
      if (chunk.length === 0) break;
      for (const f of chunk) { mirror.push(f); if (f.seq > cursor) cursor = f.seq; }
      if (chunk.length < 1000) break;
    }
  };

  let won = 0;
  let done = 0;
  const held: string[] = []; // victim mode: claims won but not yet resolved
  const t0 = Date.now();

  console.log(`[${author}] online — folding the fact stream, no orders taken`);

  while (Date.now() - t0 < maxMs) {
    await pull();
    const view = foldTasks(mirror, Date.now() / 1000, delta);
    let resolved = 0;
    const openList: TaskView[] = [];
    for (const t of view.values()) {
      if (t.state === "resolved") resolved++;
      else if (t.state === "open" && !held.includes(t.id)) openList.push(t);
    }
    if (total > 0 && resolved >= total) break;
    const firstOpen = openList[0] ?? null;

    if (mode === "victim") {
      // top the batch up first: hold many live claims at once, so a mid-run
      // kill strands real work the swarm must re-dispatch
      while (held.length < batch && openList.length > 0) {
        const target = openList.shift()!;
        const r = await client.claim(target.id);
        if (r.won) { held.push(target.id); won++; }
      }
      // then drain the oldest held claim slowly
      const head = held.shift();
      if (head) {
        await sleep(workMs);
        const st = await client.state(head);
        if (st.state === "claimed" && st.owner === author) {
          await client.resolve(head, [{ type: "task.done", payload: { by: author } }]);
          done++;
        }
      }
    } else if (firstOpen) {
      const r = await client.claim(firstOpen.id);
      if (r.won) {
        won++;
        await sleep(workMs + Math.floor(Math.random() * workMs));
        // exactly-once guard: re-fold right before committing; an expired or
        // lost claim must NEVER produce a resolve/done
        const st = await client.state(firstOpen.id);
        if (st.state === "claimed" && st.owner === author) {
          await client.resolve(firstOpen.id, [
            { type: "task.done", payload: { i: firstOpen.i, by: author } },
          ]);
          done++;
        }
      }
    }
    await sleep(10 + Math.floor(Math.random() * 15));
  }

  console.log(`[${author}] offline — won=${won} resolved=${done}`);
  return 0;
}

const isEntry = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();

if (isEntry) {
  workerMain()
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`[worker] fatal: ${e instanceof Error ? e.message : e}`); process.exit(2); });
}
