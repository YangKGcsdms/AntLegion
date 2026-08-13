/**
 * m1m3-run.ts — the paired M1/M3 experiment, one command:
 *
 *   npx tsx experiments/m1m3-run.ts                 # full grid: N ∈ {2,4,8} × both arms
 *   npx tsx experiments/m1m3-run.ts --n 4 --arm a   # one round
 *   npx tsx experiments/m1m3-run.ts --reqs 10       # bigger workload
 *
 * A 臂 = N isolated processes + deterministic human-relay script (baseline);
 * B 臂 = same N processes + AntLegion bus, auto-gate OFF (harness plays the
 * human at H1). Same requirements, same simulated workers, same human
 * think-time budget. Results land in experiments/results/ as JSON and a
 * ready-to-paste markdown table (the M3 curve's data points).
 *
 * Needs no API key, no docker, no running bus (each B round boots its own).
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { runArmA } from "./m1m3-arm-a.js";
import { runArmB } from "./m1m3-arm-b.js";
import { HUMAN, type RoundResult } from "./m1m3-lib.js";

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");

function table(results: RoundResult[]): string {
  const by = (arm: "A" | "B", n: number) => results.find((r) => r.arm === arm && r.n === n);
  const ns = [...new Set(results.map((r) => r.n))].sort((a, b) => a - b);
  const lines = [
    "| N | A臂 M1中继（搬运+查看） | A臂 裁决 | B臂 M1中继 | B臂 裁决 | A臂 M2 跨度(阶段/最长无人值守s) | B臂 M2 跨度(阶段/最长无人值守s) | A臂耗时s | B臂耗时s |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const n of ns) {
    const a = by("A", n);
    const b = by("B", n);
    const f = (r: RoundResult | undefined, fn: (x: RoundResult) => string) => (r ? fn(r) : "—");
    lines.push(`| ${n} | ${f(a, (x) => `**${x.m1_relay}** (${x.touches.carry}+${x.touches.glance})`)} | ${f(a, (x) => String(x.m1_adjudication))} | ${f(b, (x) => `**${x.m1_relay}**`)} | ${f(b, (x) => String(x.m1_adjudication))} | ${f(a, (x) => `${x.m2_stage_span} / ${x.m2_max_gap_s}`)} | ${f(b, (x) => `${x.m2_stage_span} / ${x.m2_max_gap_s}`)} | ${f(a, (x) => String(x.elapsed_s))} | ${f(b, (x) => String(x.elapsed_s))} |`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let ns = [2, 4, 8];
  let arms: Array<"a" | "b"> = ["a", "b"];
  let reqs = 6;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n") ns = args[++i]!.split(",").map((x) => parseInt(x, 10));
    else if (args[i] === "--arm") arms = args[++i]!.split(",").map((x) => x.trim().toLowerCase()) as Array<"a" | "b">;
    else if (args[i] === "--reqs") reqs = parseInt(args[++i]!, 10);
    else { console.error("usage: m1m3-run [--n 2,4,8] [--arm a,b] [--reqs 6]"); process.exit(2); }
  }

  console.error(`[m1m3] grid: N ∈ {${ns.join(",")}} × arms {${arms.join(",")}} · ${reqs} reqs/round · human model ${JSON.stringify(HUMAN)}`);
  const results: RoundResult[] = [];
  for (const n of ns) {
    for (const arm of arms) {
      console.error(`\n[m1m3] ── round: arm ${arm.toUpperCase()}, N=${n} ──`);
      const r = arm === "a" ? await runArmA(n, reqs) : await runArmB(n, reqs);
      results.push(r);
      console.error(`[m1m3] done: ${JSON.stringify(r)}`);
    }
  }

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = { ran_at: new Date().toISOString(), reqs_per_round: reqs, human_model: HUMAN, results };
  await fs.writeFile(path.join(RESULTS_DIR, `m1m3-${stamp}.json`), JSON.stringify(payload, null, 2));
  await fs.writeFile(path.join(RESULTS_DIR, "m1m3-latest.json"), JSON.stringify(payload, null, 2));

  console.log("\n══════════ M1/M3 PAIRED RESULT ══════════");
  console.log(table(results));
  console.log(`\nresults → experiments/results/m1m3-${stamp}.json`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
