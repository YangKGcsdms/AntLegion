/**
 * How much does a normative answer cost the reader?
 *
 *   npx tsx examples/mock-colony/fold-cost.ts
 *
 * §8.0 requires a **complete prefix** for any normative result, and §11.2
 * forbids compaction from changing a fold's answer — so a conforming reader
 * retains every fact's skeleton for the life of the log, and every fold walks
 * it. The specification never states either cost. This measures both, because
 * "the bus is stateless and readers do the work" is only a good trade if the
 * work is affordable.
 */

import { computeId } from "../../src/hash.js";
import { lifecycle, current, history, trust, descendants } from "../../src/fold.js";
import type { Fact } from "../../src/types.js";

const SIZES = [1_000, 10_000, 100_000];
const DELTA = 600;

/** A synthetic log shaped like the mock colony's: tasks, claims, resolves, registers. */
function synth(n: number): { facts: Fact[]; taskIds: string[]; subjects: string[] } {
  const facts: Fact[] = [];
  const taskIds: string[] = [];
  const subjects: string[] = [];
  let seq = 0;
  const mk = (type: string, author: string, refs: Record<string, string> = {}, payload: Record<string, unknown> = {}): Fact => {
    const ts = seq + 1;
    const input = { type, author, ts, payload, refs, nonce: String(seq) };
    const f: Fact = { seq: ++seq, recv: seq, id: computeId(input), type, author, ts, payload, refs, nonce: String(seq - 1), sig: "" };
    facts.push(f);
    return f;
  };

  while (facts.length < n) {
    const w = `worker-${facts.length % 8}`;
    const task = mk("task.open", "seed");
    taskIds.push(task.id);
    mk("_.claim", w, { claim_of: task.id });
    mk("_.resolve", w, { resolves: task.id });
    mk("task.done", w, { parent: task.id });
    const subj = `sensor:${facts.length % 40}`;
    if (!subjects.includes(subj)) subjects.push(subj);
    mk("sensor.reading", `sensor-${facts.length % 4}`, { subject: subj }, { v: facts.length });
    mk("_.vote", `voter-${facts.length % 3}`, { vote: task.id }, { verdict: "corroborate" });
  }
  return { facts: facts.slice(0, n), taskIds, subjects };
}

const ms = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };

console.log("reader cost — one normative answer over a complete prefix\n");
console.log("  facts   heap(MB)  lifecycle  current   history    trust  descendants");
console.log("  ─────   ────────  ─────────  ───────   ───────    ─────  ───────────");

for (const n of SIZES) {
  const { facts, taskIds, subjects } = synth(n);
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  const target = taskIds[Math.floor(taskIds.length / 2)];
  const subj = subjects[Math.floor(subjects.length / 2)];

  const tLife = ms(() => { lifecycle(facts, target, { claimTimeout: DELTA, now: 1e9 }); });
  const tCur = ms(() => { current(facts, subj); });
  const tHist = ms(() => { history(facts, subj); });
  const tTrust = ms(() => { trust(facts, target, 2); });
  const tDesc = ms(() => { descendants(facts, target); });

  console.log(
    `  ${String(n).padStart(6)}  ${heapMB.toFixed(0).padStart(8)}  ` +
    `${tLife.toFixed(2).padStart(9)}  ${tCur.toFixed(2).padStart(7)}  ` +
    `${tHist.toFixed(2).padStart(8)}  ${tTrust.toFixed(2).padStart(7)}  ${tDesc.toFixed(2).padStart(11)}`,
  );
}

console.log(`
  All times in ms for ONE call. Every fold is a full scan of the prefix, so a
  reader answering K questions about a log of N facts does O(K·N) work, and it
  must hold all N to be allowed a normative answer at all (§8.0).

  This is not a bug — it is the price of "the bus is stateless and meaning lives
  in the reader". It is worth stating because the specification does not: §11.2
  reclaims payloads, never skeletons, so a reader's floor grows monotonically
  with the age of the log and nothing in the protocol bounds it.`);
