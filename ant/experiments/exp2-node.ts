/**
 * exp2-node.ts — child-process entry for the M6 repeat round (exp2-repeat.ts).
 *
 * Runs stock `src/` DCUs (unmodified) as one OS process, so a `kill -9` on
 * this process is a whole-node crash: the claim it holds dies with it and
 * only the §3.1 recv-anchored expiry can transfer ownership.
 *
 * Env:
 *   S2EXT_BUS_URL     bus to join
 *   S2EXT_WORKSPACE   dcu workspace dir
 *   S2EXT_STAGES      csv of stages to run (e.g. "dev" or "plan,unittest,e2e")
 *   S2EXT_REPLICA     replica index for the stage DCUs (default 0)
 *   S2EXT_SUPPORT     "1" → also run adjudicator + gate-approver
 *   ANT_CLAIM_DELTA   claim-expiry Δ in seconds (inherited by every fold)
 */

import { runDCU } from "../src/runtime.js";
import { stageDCU, adjudicatorDCU } from "../src/dcus/devchain-dcus.js";
import { gateApproverDCU } from "../src/dcus/gate-approver.js";
import { STAGES, type Stage } from "../src/folds/devchain.js";

const busUrl = process.env.S2EXT_BUS_URL ?? "http://localhost:29200";
const workspace = process.env.S2EXT_WORKSPACE ?? process.cwd();
const replica = parseInt(process.env.S2EXT_REPLICA ?? "0", 10);
const stages = (process.env.S2EXT_STAGES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Stage => (STAGES as readonly string[]).includes(s));

for (const stage of stages) void runDCU(stageDCU(stage, busUrl, workspace, replica));
if (process.env.S2EXT_SUPPORT === "1") {
  void runDCU(adjudicatorDCU(busUrl));
  void runDCU(gateApproverDCU(busUrl));
}
