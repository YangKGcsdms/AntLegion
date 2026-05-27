/**
 * Scenario ② — CONSENSUS / peer review (contestable truth, no central arbiter).
 *
 * Real angle: agents report observations; some are right, some wrong. No agent
 * is authoritative. Peers corroborate/contradict; the epistemic fold (§3.2)
 * converges truth. A decider acts ONLY on `consensus` — so wrong facts, though
 * published, never get acted on. Nobody adjudicates; agreement emerges.
 *
 *   reporters (6)  → publish obs.metric {claim, truth}   (truth = mock ground-truth)
 *   reviewers (12) → corroborate true obs, contradict false obs (they verify independently)
 *   decider   (1)  → accept obs whose trust == consensus; never the refuted ones
 *
 * Run: npx tsx examples/scenario-consensus.ts
 */

import { serve } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerV2 } from "../src/v2/server.js";
import { ClientV2, httpTransport } from "../src/v2/client.js";
import { trust } from "../src/v2/fold.js";

const REPORTERS = 6, REVIEWERS = 12, OBS_PER_REPORTER = 2; // 12 obs: 6 true, 6 false
const TOTAL_OBS = REPORTERS * OBS_PER_REPORTER;
const QUORUM = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-consensus-"));
  const { app } = createServerV2({ secret: "consensus", dataDir: dir, fsync: "no" });
  let server: { close: () => void };
  const port = await new Promise<number>((res) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (i) => res(i.port));
    server = s as unknown as { close: () => void };
  });
  const base = `http://localhost:${port}`;
  const client = (n: string) => new ClientV2(httpTransport(base), n);
  let stop = false;

  // reporters publish observations, alternating true/false as mock ground truth
  let toggle = false;
  for (let r = 0; r < REPORTERS; r++) {
    const c = client(`reporter-${r}`);
    for (let j = 0; j < OBS_PER_REPORTER; j++) {
      toggle = !toggle;
      await c.publish("obs.metric", { claim: `r${r}.m${j}`, truth: toggle });
    }
  }

  // reviewers independently verify and vote (corroborate true / contradict false)
  const reviewers = Array.from({ length: REVIEWERS }, (_, k) =>
    (async () => {
      const c = client(`reviewer-${k}`);
      const voted = new Set<string>();
      while (!stop) {
        for (const f of await c.query({ type: "obs.metric", limit: 200 })) {
          if (voted.has(f.id)) continue;
          voted.add(f.id);
          await c.observe(f.id, (f.payload as { truth: boolean }).truth ? "corroborate" : "contradict");
        }
        await sleep(15);
      }
    })());

  // decider acts only on consensus
  const decider = (async () => {
    const c = client("decider");
    const accepted = new Set<string>();
    while (!stop) {
      await c.sync();
      const obs = await c.query({ type: "obs.metric", limit: 200 });
      for (const f of obs) {
        if (accepted.has(f.id)) continue;
        if ((await c.trustOf(f.id, QUORUM)) === "consensus") {
          accepted.add(f.id);
          await c.publish("decision.accept", { of: f.id });
        }
      }
      // done when every obs has settled (consensus or refuted)
      if (obs.length === TOTAL_OBS) {
        let settled = 0;
        for (const f of obs) {
          const t = await c.trustOf(f.id, QUORUM);
          if (t === "consensus" || t === "refuted") settled++;
        }
        if (settled === TOTAL_OBS) { await c.publish("review.complete", {}); break; }
      }
      await sleep(30);
    }
  })();

  const t0 = Date.now();
  let completed = false;
  const probe = client("probe");
  while (Date.now() - t0 < 25000) {
    if ((await probe.query({ type: "review.complete" })).length > 0) { completed = true; break; }
    await sleep(60);
  }
  const elapsed = Date.now() - t0;
  stop = true;
  await Promise.allSettled([...reviewers, decider]);

  // ── validate ──
  const all = await probe.query({ since: 0, limit: 100000 });
  const obs = all.filter((f) => f.type === "obs.metric");
  const accepts = new Set(all.filter((f) => f.type === "decision.accept").map((f) => (f.payload as { of: string }).of));
  const trueObs = obs.filter((f) => (f.payload as { truth: boolean }).truth);
  const falseObs = obs.filter((f) => !(f.payload as { truth: boolean }).truth);

  const trueConsensus = trueObs.filter((f) => trust(all, f.id, QUORUM) === "consensus");
  const falseRefuted = falseObs.filter((f) => trust(all, f.id, QUORUM) === "refuted");
  const trueAccepted = trueObs.filter((f) => accepts.has(f.id));
  const falseAccepted = falseObs.filter((f) => accepts.has(f.id));

  console.log("\n══════════ Scenario ② CONSENSUS (peer review, no arbiter) ══════════");
  console.log(`agents               : ${REPORTERS} reporters + ${REVIEWERS} reviewers + 1 decider`);
  console.log(`completed (emergent) : ${completed ? "YES" : "NO (timeout)"} in ${elapsed} ms`);
  console.log(`observations         : ${obs.length}  (${trueObs.length} true / ${falseObs.length} false)`);
  console.log(`true → consensus     : ${trueConsensus.length}/${trueObs.length}`);
  console.log(`false → refuted      : ${falseRefuted.length}/${falseObs.length}`);
  console.log(`accepted by decider  : ${accepts.size}  (true:${trueAccepted.length}  false:${falseAccepted.length})`);
  console.log(`votes cast           : ${all.filter((f) => f.type === "_.vote").length}`);

  const PASS =
    completed &&
    obs.length === TOTAL_OBS &&
    trueConsensus.length === trueObs.length &&
    falseRefuted.length === falseObs.length &&
    trueAccepted.length === trueObs.length &&
    falseAccepted.length === 0; // the key safety property: no wrong fact acted on
  console.log(`\nVERDICT: ${PASS ? "✅ truth converged via peer review; decider acted only on consensus, never on refuted" : "❌ convergence or safety violated"}`);
  console.log("════════════════════════════════════════════════════════════════════\n");

  server!.close();
  process.exit(PASS ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
