/**
 * Scenario ④ — SHARED VIEW (isolated nodes, one world, zero claims).
 *
 * The thing the fact log is actually for: agents that share NO memory, NO
 * process, NO framework — only the log — must still agree, bit-for-bit, on
 * what is true right now, how it came to be, and what it led to.
 *
 * Think pheromone, not orders. Sensors deposit what they observed on the ground
 * (facts with a `subject`). Nobody tells anybody anything. Readers on other
 * nodes wake whenever they like, sense the ground, and fold their own picture
 * of the world. Fresh pheromone over stale (§3.3 latest-wins), a trail from
 * cause to effect (§3.4), and evaporation (§5.2 tombstone) — all reader folds.
 *
 *   sensors  (S) → each owns some subjects `sensor:<k>`; re-deposits readings at
 *                  its own pace via `supersede`, sometimes with a `parent`
 *                  (an alarm caused by a reading); one sensor is killed mid-run
 *   readers  (R) → cold, independent mirrors that wake at random times, fold
 *                  {current per subject, history len, causation of current,
 *                   descendants of every alarm} and hash that view
 *   PASS iff  (1) every reader's world-view hash is identical at the same head
 *             (2) the bus is killed + replayed from its journal and a fresh
 *                 reader folds the very same hash from the very same journal
 *             (3) a retracted subject folds to null on every reader — never to
 *                 the previous value — and (4) the run contains zero `_.claim`
 *
 * Run: npx tsx examples/scenario-shared-view.ts
 */

import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerV2 } from "../src/server.js";
import { ClientV2, httpTransport } from "../src/client.js";
import type { Fact } from "../src/types.js";
import { current, history, causationChain, descendants } from "../src/fold.js";

const SENSORS = 6, SUBJECTS_PER = 3, READERS = 8, ROUNDS = 12;
const SECRET = "shared-view";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Running { port: number; close: () => void; closeBus: () => void }
async function boot(dir: string, port = 0): Promise<Running> {
  const { app, bus } = createServerV2({ secret: SECRET, dataDir: dir, fsync: "no" });
  let server: { close: () => void } | null = null;
  const p = await new Promise<number>((res) => {
    const s = serve({ fetch: app.fetch, port }, (i) => res(i.port));
    server = s as unknown as { close: () => void };
  });
  return { port: p, close: () => server!.close(), closeBus: () => bus.close() };
}

/**
 * One reader's whole picture of the world — a pure function of the stream it
 * mirrored. The reader pulls the log once (cold, cursor from 0), freezes it,
 * and folds locally with the same fold.ts every other reader uses. No server
 * call answers "what is current" — the reader computes it.
 */
async function worldView(c: ClientV2, subjects: string[]): Promise<{ head: number; view: string }> {
  const stream: Fact[] = [];
  let since = 0;
  for (;;) {
    const batch = await c.query({ since, limit: 500 });
    if (!batch.length) break;
    stream.push(...batch);
    since = batch[batch.length - 1].seq;
    if (batch.length < 500) break;
  }
  const head = stream.length ? stream[stream.length - 1].seq : 0;
  const parts: unknown[] = [];
  for (const s of subjects) {
    const cur = current(stream, s);
    const chain = cur ? causationChain(stream, cur.id).map((f) => f.id) : [];
    parts.push([s, cur ? cur.id : null, cur ? cur.payload : null, history(stream, s).length, chain]);
  }
  for (const a of stream.filter((f) => f.type === "alarm.raised")) {
    parts.push(["alarm", a.id, descendants(stream, a.id).map((f) => f.id)]);
  }
  return { head, view: sha(JSON.stringify(parts)) };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-shared-view-"));
  let bus = await boot(dir);
  const base = () => `http://localhost:${bus.port}`;
  const client = (n: string) => new ClientV2(httpTransport(base()), n);

  const subjects = Array.from({ length: SENSORS }, (_, i) =>
    Array.from({ length: SUBJECTS_PER }, (_, k) => `sensor:${i}:${k}`)).flat();

  // ── sensors: deposit readings; supersede at their own pace; some raise alarms ──
  let killed = -1;
  const sensorRuns = Array.from({ length: SENSORS }, (_, i) => (async () => {
    const c = client(`sensor-${i}@node-${i}`);
    const last = new Map<string, string>();
    for (let round = 0; round < ROUNDS; round++) {
      if (i === killed) return; // SIGKILL'd mid-run: its last deposits simply stay current
      for (let k = 0; k < SUBJECTS_PER; k++) {
        const subj = `sensor:${i}:${k}`;
        const payload = { value: Math.round(Math.random() * 100), round };
        const prev = last.get(subj);
        const r = prev
          ? await c.supersede(prev, "sensor.reading", payload)
          : await c.publish("sensor.reading", payload, { refs: { subject: subj } });
        last.set(subj, r.id);
        if (payload.value > 90) {
          const alarm = await c.publish("alarm.raised", { subj, value: payload.value }, { refs: { parent: r.id } });
          await c.publish("alarm.acked", {}, { refs: { parent: alarm.id } });
        }
      }
      await sleep(5 + Math.random() * 20);
    }
  })());
  setTimeout(() => { killed = 2; }, 60);

  // ── readers: cold mirrors on other "nodes", waking at random times ──
  const mid: Array<{ head: number; view: string }> = [];
  const readerRuns = Array.from({ length: READERS }, (_, j) => (async () => {
    await sleep(Math.random() * 120);
    const c = client(`reader-${j}@elsewhere-${j}`);
    mid.push(await worldView(c, subjects));
  })());

  await Promise.all([...sensorRuns, ...readerRuns]);

  // ── (1) quiescent: every reader, from a cold mirror, folds one identical world ──
  const finals = await Promise.all(Array.from({ length: READERS }, (_, j) => worldView(client(`final-${j}@n${j}`), subjects)));
  const heads = new Set(finals.map((f) => f.head));
  const views = new Set(finals.map((f) => f.view));
  const sameHeadSameView = (() => {
    // mid-run readers who happened to see the same head must have seen the same world
    const byHead = new Map<number, Set<string>>();
    for (const m of mid) (byHead.get(m.head) ?? byHead.set(m.head, new Set()).get(m.head)!).add(m.view);
    return [...byHead.values()].every((s) => s.size === 1);
  })();

  // ── (3) retraction: tombstone one current reading; must fold to null everywhere ──
  const retractor = client("retractor@ops");
  const victim = subjects[0];
  const cur = await retractor.currentOf(victim);
  if (cur) await retractor.tombstone(cur.id);
  const afterRetract = await Promise.all(Array.from({ length: 3 }, (_, j) => client(`post-${j}`).currentOf(victim)));
  const retractedEverywhere = afterRetract.every((x) => x === null);

  // ── (2) kill the bus; replay from journal; a fresh reader folds the same hash ──
  const before = await worldView(client("auditor-before"), subjects);
  bus.close(); bus.closeBus();
  await sleep(200);
  bus = await boot(dir);
  const after = await worldView(client("auditor-after"), subjects);

  // ── (4) no claims anywhere ──
  const claims = await client("counter").query({ type: "_.claim", limit: 10 });
  const all = await client("counter").query({ limit: 100000 });

  console.log("\n══════════ Scenario ④ SHARED VIEW (isolated nodes · one world · zero claims) ══════════");
  console.log(`nodes                 : ${SENSORS} sensors (1 killed mid-run) + ${READERS} readers waking at random`);
  console.log(`facts                 : ${all.length}  (subjects=${subjects.length}, supersessions=${all.filter((f) => f.refs.supersedes).length}, alarms=${all.filter((f) => f.type === "alarm.raised").length})`);
  console.log(`(1) readers agree     : ${views.size === 1 && heads.size === 1 ? "YES" : "NO"}  — ${finals.length} cold readers, ${views.size} distinct world-view hash at head ${[...heads].join(",")}`);
  console.log(`    mid-run same head ⇒ same view : ${sameHeadSameView ? "YES" : "NO"}  (${mid.length} wakes at ${new Set(mid.map((m) => m.head)).size} distinct heads)`);
  console.log(`(2) replay identical  : ${before.view === after.view && before.head === after.head ? "YES" : "NO"}  — sha256 ${before.view.slice(0, 16)}… == ${after.view.slice(0, 16)}…`);
  console.log(`(3) retraction        : ${retractedEverywhere ? "YES" : "NO"}  — '${victim}' folds to null on every reader (never the previous value)`);
  console.log(`(4) claims in stream  : ${claims.length}  (this scenario coordinates nothing — it only shares a world)`);
  const PASS = views.size === 1 && heads.size === 1 && sameHeadSameView && before.view === after.view && retractedEverywhere && claims.length === 0;
  console.log(`\nVERDICT: ${PASS ? "✅ isolated nodes fold one identical world — current, history, causation, descendants — before and after replay" : "❌ shared-view invariant violated"}`);

  bus.close(); bus.closeBus();
  process.exit(PASS ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
