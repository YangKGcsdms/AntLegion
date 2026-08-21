/**
 * One isolated agent. Its own OS process, its own mirror, its own clock.
 *
 *   npx tsx agent.ts <role> <name> <busUrl>
 *
 * The agent knows exactly two things about the world: a bus URL, and its own
 * name. It is handed no task list, no peer list, no phase schedule and no
 * shutdown signal — everything it does is decided by folding the log. That is
 * the point of the harness: if any of these roles needed an out-of-band channel
 * to work, the protocol's central claim would be false.
 *
 * Verdicts go to stdout as `RESULT <json>` lines; everything else is stderr.
 */

import { ClientV2, httpTransport } from "../../src/client.js";
import { current, history, lifecycle, causationChain, isGap, trust } from "../../src/fold.js";
import type { Fact } from "../../src/types.js";
import { createHash } from "node:crypto";

const [role, name, busUrl, headArg] = process.argv.slice(2);
/** When set, fold a PINNED prefix (seq ≤ head). §9.2 is about one prefix. */
const pinnedHead = headArg ? Number(headArg) : null;
const log = (m: string) => process.stderr.write(`[${name}] ${m}\n`);
const emit = (v: unknown) => process.stdout.write(`RESULT ${JSON.stringify(v)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The run's phase register. Every agent folds it; nobody is told. */
const PHASE = "run:phase";
const TASK_SUBJECT = "run:tasks";

const client = new ClientV2(httpTransport(busUrl), name);

async function busDelta(): Promise<number> {
  const info = (await client.info()) as { claim_timeout?: number };
  return typeof info.claim_timeout === "number" ? info.claim_timeout : 600;
}

async function phase(): Promise<string> {
  await client.sync();
  const f = await client.currentOf(PHASE);
  return (f?.payload as { phase?: string })?.phase ?? "boot";
}

/** Block until the log says we are in (or past) one of these phases. */
async function until(...want: string[]): Promise<string> {
  for (;;) {
    const p = await phase();
    if (want.includes(p) || p === "done") return p;
    await sleep(120);
  }
}

const stream = async (): Promise<Fact[]> => client.query({ since: 0, limit: 20000 });

// ─────────────────────────────── the roles ──────────────────────────────────

/**
 * Race for every open task, do the work, resolve it. Exercises §9.1 (only one
 * of us may conclude it won a given task) and §9.4 (a byte-identical resubmit
 * of our own claim must not become a second claim).
 */
async function worker(): Promise<void> {
  const delta = await busDelta();
  await until("work");
  const won: string[] = [];
  const lost: string[] = [];
  let dedupObserved = false;

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if ((await phase()) !== "work") break;
    const all = await stream();
    const tasks = all.filter((f) => f.type === "task.open");
    let acted = false;

    for (const t of tasks) {
      const st = lifecycle(all, t.id, { claimTimeout: delta });
      if (st.state !== "open") continue;

      const r = await client.claim(t.id);
      if (!r.won) { if (!lost.includes(t.id)) lost.push(t.id); continue; }
      acted = true;
      won.push(t.id);

      // §9.4: resubmit our own claim byte-for-byte. The bus must recognize it
      // as the same fact and NOT hand it a second seq — otherwise a retry
      // through a dropped connection would quietly become a second claim.
      const mine = (await stream())
        .filter((f) => f.author === name && f.refs.claim_of === t.id)
        .sort((a, b) => a.seq - b.seq)[0];
      if (mine) {
        const again = await client.query({ since: 0, limit: 1 }).then(async () => {
          const res = await fetch(`${busUrl}/facts`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: mine.type, author: mine.author, ts: mine.ts,
              payload: mine.payload, refs: mine.refs, nonce: mine.nonce,
            }),
          });
          return { status: res.status, body: await res.json() as { seq: number; deduped: boolean } };
        });
        if (again.status === 200 && again.body.deduped && again.body.seq === mine.seq) dedupObserved = true;
      }

      await sleep(60 + Math.random() * 120);          // "do the work"
      try {
        await client.resolve(t.id, [{ type: "task.done", payload: { by: name } }]);
      } catch (err) {
        // Our claim lapsed while we worked, or someone else's resolve landed
        // first. Both are legitimate outcomes and the fold decides, not us.
        won.splice(won.indexOf(t.id), 1);
        lost.push(t.id);
        log(`resolve refused for ${t.id.slice(0, 8)} — ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!acted) await sleep(150);
  }

  emit({ role, name, won, lost, dedupObserved });
}

/**
 * Claim two tasks and die without resolving. Nothing detects the crash: the
 * claims lapse at recv + Δ and the work becomes re-dispatchable by arithmetic
 * over two bus-stamped numbers (§8.4).
 */
async function crasher(): Promise<void> {
  const delta = await busDelta();
  await until("work");
  const taken: string[] = [];
  // Keep trying until we actually hold two. Four workers are racing for the
  // same pool, so a single pass over the first few tasks reliably loses.
  const deadline = Date.now() + 8_000;
  while (taken.length < 2 && Date.now() < deadline) {
    const all = await stream();
    for (const t of all.filter((f) => f.type === "task.open")) {
      if (lifecycle(all, t.id, { claimTimeout: delta }).state !== "open") continue;
      const r = await client.claim(t.id);
      if (r.won) taken.push(t.id);
      if (taken.length === 2) break;
    }
    if (taken.length < 2) await sleep(100);
  }
  emit({ role, name, taken });
  await sleep(200);
  log(`holding ${taken.length} claims — dying without resolving`);
  process.exit(137);                                  // SIGKILL-shaped exit
}

/**
 * Try every gated thing §10.1 forbids, plus the field domains of §5. Records
 * what actually happened rather than what should have: an attack that silently
 * succeeds is the finding.
 */
async function mallory(): Promise<void> {
  await until("attack");
  const all = await stream();
  const victim = all.find((f) => f.type === "sensor.reading" && f.author !== name);
  const task = all.find((f) => f.type === "task.open");
  const out: Record<string, unknown> = {};

  const post = async (body: unknown) => {
    const res = await fetch(`${busUrl}/facts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };
  const now = () => Date.now() / 1000;

  // §5 field domains — the bus must refuse these outright.
  out.nonFiniteTs = (await post({ type: "evil.probe", author: name, ts: 1e999, payload: {} })).status;
  out.badType = (await post({ type: "has space", author: name, ts: now(), payload: {} })).status;
  out.emptyRefValue = (await post({ type: "evil.probe", author: name, ts: now(), payload: {}, refs: { parent: "" } })).status;
  out.twoLifecycleRefs = (await post({
    type: "_.claim", author: name, ts: now(), payload: {},
    refs: { claim_of: task?.id ?? "x".repeat(64), resolves: task?.id ?? "y".repeat(64) },
  })).status;
  out.arrayPayload = (await post({ type: "evil.probe", author: name, ts: now(), payload: [] })).status;

  // §10.1 fold gates — the bus ACCEPTS these (it does not judge meaning); the
  // readers must refuse to honour them. Both halves matter.
  if (victim) {
    out.strangerTombstoneAccepted = (await post({
      type: "_.tombstone", author: name, ts: now(), payload: {}, refs: { tombstones: victim.id }, nonce: "m1",
    })).status;
    // Shape A — supersede WITHOUT carrying the subject. This is the shape the
    // §10.1 gate exists for: nothing but the `supersedes` link is asserted.
    out.strangerSupersedeBareAccepted = (await post({
      type: "sensor.reading", author: name, ts: now(), payload: { v: 666 },
      refs: { supersedes: victim.id }, nonce: "m2",
    })).status;
  }

  // Shape B — a subject-less fact by a third author, then a stranger's bare
  // supersede on it. §8.1 rule 4 says the gate protects this fact's trust state.
  const lone = all.find((f) => f.type === "chain.step" && f.author !== name && !f.refs.subject);
  if (lone) {
    out.strangerSupersedeLoneAccepted = (await post({
      type: "chain.step", author: name, ts: now(), payload: { hijack: true },
      refs: { supersedes: lone.id }, nonce: "m5",
    })).status;
    out.loneTarget = lone.id;
  }

  // Shape C — the sanctioned path §8.1 rule 4 itself names: just write to the
  // shared register. No `supersedes` at all. Recorded so the harness can show
  // what this does to the victim's trust state.
  if (victim) {
    out.strangerRegisterWriteAccepted = (await post({
      type: "sensor.reading", author: name, ts: now(), payload: { v: 777 },
      refs: { subject: victim.refs.subject! }, nonce: "m6",
    })).status;
  }
  // A resolve on something we never claimed, and a release we never held.
  const unclaimed = all.find((f) => f.type === "announce.open");
  if (unclaimed) {
    out.resolveNeverClaimedAccepted = (await post({
      type: "_.resolve", author: name, ts: now(), payload: {}, refs: { resolves: unclaimed.id }, nonce: "m3",
    })).status;
  }
  if (task) {
    out.releaseNotHeldAccepted = (await post({
      type: "_.release", author: name, ts: now(), payload: {}, refs: { release_of: task.id }, nonce: "m4",
    })).status;
  }

  emit({ role, name, attacks: out, victim: victim?.id ?? null, unclaimed: unclaimed?.id ?? null });
}

/** Write a register and revise it. Only our own supersedes are authorized (§10.1). */
async function sensor(idx: number): Promise<void> {
  await until("observe");
  const subjects = [`sensor:${idx}:a`, `sensor:${idx}:b`];
  const written: Record<string, string[]> = {};
  for (const subj of subjects) {
    written[subj] = [];
    let prev: string | null = null;
    for (let round = 0; round < 4; round++) {
      const payload = { v: idx * 100 + round, round };
      const r = prev
        ? await client.supersede(prev, "sensor.reading", payload)
        : await client.publish("sensor.reading", payload, { refs: { subject: subj } });
      written[subj].push(r.id);
      prev = r.id;
      await sleep(40);
    }
  }
  emit({ role, name, written });
}

/** Retract our own register head: §8.1 says the register folds to null, never back. */
async function retractor(): Promise<void> {
  await until("observe");
  const subj = "retract:me";
  const ids: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < 3; i++) {
    const r = prev
      ? await client.supersede(prev, "retract.value", { i })
      : await client.publish("retract.value", { i }, { refs: { subject: subj } });
    ids.push(r.id);
    prev = r.id;
  }
  await until("attack");
  await client.tombstone(ids[ids.length - 1]);
  emit({ role, name, subject: subj, ids, retracted: ids[ids.length - 1] });
}

/**
 * Build a causal chain, and one leaf whose parent never arrives. §8.2 requires
 * that unresolved ancestor to surface as an explicit gap — a chain that looks
 * complete but is not turns "I could not see the origin" into "this is the
 * origin".
 */
async function chainer(): Promise<void> {
  await until("observe");
  const chain: string[] = [];
  let parent: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = await client.publish("chain.step", { i }, { refs: parent ? { parent } : {} });
    chain.push(r.id);
    parent = r.id;
  }
  const phantom = "f".repeat(64);
  const orphan = await client.publish("chain.orphan", {}, { refs: { parent: phantom } });
  emit({ role, name, chain, orphan: orphan.id, phantom });
}

/**
 * A cold reader. Folds the whole world into a hash — but deliberately splits
 * the world in two:
 *
 *   stable   — absorbing states only (§9.3): resolved/dead lifecycles, the
 *              register, the trail. Two auditors at the same head MUST agree.
 *   advisory — trailing `claimed`/`open`, which §8.4 says depend on the
 *              reader's own clock. Reported, never hashed. If these diverge
 *              between auditors that is the spec working, not a bug.
 */
async function auditor(): Promise<void> {
  if (pinnedHead === null) { await until("settle"); await sleep(400); }
  const delta = await busDelta();
  // §9.2 is a statement about ONE prefix. A pinned head is how two readers at
  // different wall-clock moments — or on opposite sides of a bus restart — are
  // asked the same question instead of two different ones.
  const raw = await stream();
  const all = pinnedHead === null ? raw : raw.filter((f) => f.seq <= pinnedHead);
  const head = all.reduce((m, f) => Math.max(m, f.seq), 0);

  const subjects = [...new Set(all.map((f) => f.refs.subject).filter((s): s is string => !!s))].sort();
  const registers = subjects.map((s) => ({
    subject: s,
    current: current(all, s)?.id ?? null,
    history: history(all, s).map((f) => f.id),
  }));

  const tasks = all.filter((f) => f.type === "task.open").sort((a, b) => a.seq - b.seq);
  const stable: Array<{ id: string; state: string; owner: string | null }> = [];
  const advisory: Array<{ id: string; state: string; owner: string | null }> = [];
  for (const t of tasks) {
    const st = lifecycle(all, t.id, { claimTimeout: delta });
    (st.state === "resolved" || st.state === "dead" ? stable : advisory)
      .push({ id: t.id, state: st.state, owner: st.owner });
  }

  // Trust of a few designated facts, so the harness can see what a stranger's
  // register write does to someone else's confidence level (§8.3 vs §8.1).
  const trusted: Record<string, string> = {};
  for (const f of all.filter((x) => x.type === "sensor.reading" || x.type === "chain.step").slice(0, 12)) {
    try { trusted[f.id.slice(0, 8)] = trust(all, f.id, 2); } catch { /* not in prefix */ }
  }

  const orphan = all.find((f) => f.type === "chain.orphan");
  const chainOfOrphan = orphan
    ? causationChain(all, orphan.id).map((n) => (isGap(n) ? `GAP:${n.missing.slice(0, 8)}` : n.id.slice(0, 8)))
    : [];

  const worldHash = createHash("sha256")
    .update(JSON.stringify({ registers, stable, chainOfOrphan, trusted }))
    .digest("hex");

  emit({ role, name, head, pinnedHead, worldHash, registers, stable, advisory, chainOfOrphan, trusted, facts: all.length });
}

// ────────────────────────────────── main ────────────────────────────────────

async function main(): Promise<void> {
  await client.publish("sys.registry", { interests: [`${role}.*`], publishes: [role], role });
  log(`up — role ${role}, bus ${busUrl}`);

  switch (role) {
    case "worker": await worker(); break;
    case "crasher": await crasher(); break;
    case "mallory": await mallory(); break;
    case "sensor": await sensor(Number(name.split("-")[1] ?? 0)); break;
    case "retractor": await retractor(); break;
    case "chainer": await chainer(); break;
    case "auditor": await auditor(); break;
    default: throw new Error(`unknown role ${role}`);
  }
  log("done");
}

main().catch((err) => {
  log(`FAILED ${err instanceof Error ? err.stack : String(err)}`);
  emit({ role, name, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
