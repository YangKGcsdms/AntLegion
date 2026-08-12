/**
 * mvp.ts — the MVP throughput run: one bus, the whole DCU fleet, N
 * requirements fed through the dev-chain, every trigger→claim→act→resolve
 * cycle counted from the fact stream itself.
 *
 *   ant mvp [--reqs 25]
 *
 * Runs the fleet in-process with auto-gate enabled (unattended), feeds N
 * requirements, waits until every chain folds to done, then prints the
 * scoreboard. Worker mode follows ANT_WORKER (simulated | llm).
 *
 * With --reqs 25 the run produces 100 stage cycles (25 × plan/dev/unittest/
 * e2e), each one a DCU waking on a fold predicate, winning an exactly-once
 * claim, acting, and resolving with evidence — plus 100 adjudications and
 * 25 gate approvals on top.
 */

import { httpTransport } from "@antlegion/bus/client";
import type { Fact } from "@antlegion/bus/types";
import { loadConfig, dcuWorkspaceRoot } from "./config.js";
import { runDCU } from "./runtime.js";
import { devchainFleet, workerMode } from "./dcus/devchain-dcus.js";
import { createRequirement } from "./req-new.js";
import {
  foldDevchain, ARTIFACT_TYPES, EVIDENCE_ACCEPTED, EVIDENCE_REJECTED, GATE_APPROVED,
} from "./folds/devchain.js";
import { usage as llmUsage } from "./llm.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runMvp(args: string[]): Promise<void> {
  let reqs = 25;
  let noFleet = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reqs") reqs = parseInt(args[++i] ?? "", 10);
    else if (args[i] === "--no-fleet") noFleet = true;
  }
  if (!Number.isFinite(reqs) || reqs < 1) {
    console.error("usage: ant mvp [--reqs N] [--no-fleet]");
    process.exit(2);
  }

  const cfg = await loadConfig();
  const root = dcuWorkspaceRoot(cfg);
  const publisher = httpTransport(cfg.busUrl);
  const log = (m: string) => console.error(`[mvp] ${new Date().toISOString()} ${m}`);

  // Bus must be up — this driver doesn't boot one.
  try {
    const res = await fetch(`${cfg.busUrl.replace(/\/$/, "")}/health`);
    if (!res.ok) throw new Error(`health → ${res.status}`);
  } catch {
    console.error(`error: cannot reach bus at ${cfg.busUrl} — start one with: npx @antlegion/bus`);
    process.exit(1);
  }

  const t0 = Date.now();
  log(`worker=${workerMode()} reqs=${reqs} bus=${cfg.busUrl} workspace=${root}${noFleet ? " (external fleet)" : ""}`);

  if (noFleet) {
    // The fleet lives elsewhere (containers, other machines) — same bus,
    // same folds. This process only feeds and keeps score.
    log("expecting an external fleet on the bus (started with `ant chain [--dcus …]`)");
  } else {
    // The fleet: 4 stage DCUs + adjudicator + watchdog + gate-approver (unattended).
    const fleet = devchainFleet(cfg.busUrl, root, { autoGate: true });
    log(`fleet: ${fleet.map((s) => s.name).join(", ")}`);
    for (const spec of fleet) void runDCU(spec);
  }

  // Feed N requirements, staggered so the chain pipelines instead of bursting.
  const runId = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const slugs: string[] = [];
  for (let i = 1; i <= reqs; i++) {
    const slug = `mvp-${runId}-${String(i).padStart(2, "0")}`;
    const r = await createRequirement(root, `MVP需求${i}`, { slug });
    await publisher.append(r.fact);
    slugs.push(slug);
    if (i % 5 === 0) log(`fed ${i}/${reqs} requirements`);
    await sleep(300);
  }
  log(`all ${reqs} requirements fed — waiting for chains`);

  // Monitor: refold the whole stream until every chain is done.
  const mine = new Set(slugs);
  let lastDone = -1;
  for (;;) {
    await sleep(2000);
    const facts: Fact[] = [];
    let cursor = 0;
    for (;;) {
      const page = await publisher.read({ since: cursor, limit: 500 });
      if (page.length === 0) break;
      for (const f of page) { facts.push(f); if (f.seq > cursor) cursor = f.seq; }
      if (page.length < 500) break;
    }
    const views = foldDevchain(facts).filter((v) => mine.has(v.slug));
    const done = views.filter((v) => v.done).length;
    const rejected = views.flatMap((v) => v.stages.filter((s) => s.state === "rejected").map((s) => `${v.slug}:${s.stage}`));
    if (done !== lastDone) {
      lastDone = done;
      log(`chains done ${done}/${reqs} · facts ${facts.length}`);
    }
    if (rejected.length > 0) log(`REJECTED (halted): ${rejected.join(", ")}`);
    if (done === reqs) {
      printScoreboard(facts, mine, reqs, Date.now() - t0, noFleet);
      process.exit(0);
    }
  }
}

function printScoreboard(facts: Fact[], mine: Set<string>, reqs: number, elapsedMs: number, externalFleet = false): void {
  const ofRun = (f: Fact) => {
    const slug = (f.payload as Record<string, unknown> | undefined)?.reqSlug ?? (f.payload as Record<string, unknown> | undefined)?.slug;
    return typeof slug === "string" ? mine.has(slug) : false;
  };
  const count = (pred: (f: Fact) => boolean) => facts.filter(pred).length;

  const artifacts = count((f) => ARTIFACT_TYPES.has(f.type) && ofRun(f));
  const accepted = count((f) => f.type === EVIDENCE_ACCEPTED);
  const rejected = count((f) => f.type === EVIDENCE_REJECTED);
  const gates = count((f) => f.type === GATE_APPROVED && ofRun(f));
  const claims = count((f) => f.type === "_.claim");
  const resolves = count((f) => f.type === "_.resolve");

  const stageCycles = artifacts;            // each artifact = one trigger→claim→act→resolve cycle
  const responses = artifacts + accepted + rejected + gates; // every DCU wake→act→publish

  console.log("\n══════════ MVP SCOREBOARD ══════════");
  console.log(`requirements          ${reqs} (all chains ✔ done)`);
  console.log(`stage cycles          ${stageCycles}  (trigger → claim → act → resolve)`);
  console.log(`adjudications         ${accepted + rejected}  (${accepted} accepted, ${rejected} rejected)`);
  console.log(`gate approvals        ${gates}`);
  console.log(`total responses       ${responses}  (artifacts + verdicts + gates)`);
  console.log(`claims / resolves     ${claims} / ${resolves}`);
  console.log(`facts on the bus      ${facts.length}`);
  console.log(`elapsed               ${(elapsedMs / 1000).toFixed(1)}s`);
  if (workerMode() === "llm" && !externalFleet) {
    // usage lives in the same process as the fleet's workers
    console.log(`llm calls             ${llmUsage.calls} (${llmUsage.errors} errors) · tokens in/out ${llmUsage.inputTokens}/${llmUsage.outputTokens}`);
  } else if (externalFleet) {
    console.log("llm usage             see the agent containers' logs (fleet ran externally)");
  }
  console.log("═════════════════════════════════════");
}
