/**
 * m1m3-node-b.ts — one worker node for the B arm (bus).
 *
 * The same isolation approximation as the A arm (one OS process ≈ one
 * container) hosting the STOCK dev-chain DCUs from src/ — same simulated
 * workers, same durations. The only difference from the A arm's node is the
 * medium: instead of an inbox/outbox that a human must service, the node
 * polls the shared fact bus and claims its own work (exactly-once via §3.1).
 *
 * Env: M1M3_ROLE (stages|adjudicator) · M1M3_STAGES (csv) · M1M3_REPLICA ·
 *      M1M3_BUS_URL · M1M3_WORKSPACE
 */

import type { Stage } from "../src/folds/devchain.js";
import { adjudicatorDCU, stageDCU } from "../src/dcus/devchain-dcus.js";
import { runDCU, type DCUSpec } from "../src/runtime.js";

const role = process.env.M1M3_ROLE ?? "stages";
const busUrl = process.env.M1M3_BUS_URL ?? "http://localhost:28090";
const workspace = process.env.M1M3_WORKSPACE ?? process.cwd();
const replica = parseInt(process.env.M1M3_REPLICA ?? "0", 10);
const stages = (process.env.M1M3_STAGES ?? "").split(",").filter(Boolean) as Stage[];

const specs: DCUSpec[] = role === "adjudicator"
  ? [adjudicatorDCU(busUrl)]
  : stages.map((s) => stageDCU(s, busUrl, workspace, replica));

if (specs.length === 0) {
  console.error("m1m3-node-b: nothing to run (set M1M3_STAGES or M1M3_ROLE=adjudicator)");
  process.exit(2);
}

await Promise.all(specs.map((s) => runDCU(s)));
