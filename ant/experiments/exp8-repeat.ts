/**
 * exp8-repeat.ts — S2 实验三（伪造报告拦截）的 N 轮重复版（宪章 M8 稳定性）。
 *
 * exp3-forged-evidence.ts 是单次注入（8 伪造 + 4 对照，需要外置总线和裁决者）；
 * 本脚本自带全套装置——起一条独立总线（29260）+ 进程内跑原装 adjudicator DCU
 * ——把同一组探针重复 N 轮，每轮换 nonce（内容寻址下 id 全新，绕开跨轮 dedup，
 * 也让 reqSlug 带轮次），输出每轮与汇总的拦截率/误杀率稳定性表。
 *
 * 探针集与 exp3 逐字对齐（8 种形状残缺 + 4 种形状完整——复制而非 import，
 * 因为 exp3 是自执行脚本）。裁决者是确定性形状校验，本轮验证的是**管线**的
 * 稳定性（多轮注入、乱序裁决、跨轮无串扰），不是校验函数本身会不会变卦。
 *
 * 运行：cd ant && npx tsx experiments/exp8-repeat.ts [--rounds 5]
 * 无 API key、无 docker；数据目录在 tmp，成功后清理。
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { httpTransport } from "@antlegion/bus/client";
import type { Fact, FactInput } from "@antlegion/bus/types";
import { runDCU } from "../src/runtime.js";
import { adjudicatorDCU } from "../src/dcus/devchain-dcus.js";
import { killAll, mkRunDir, readAll, sleep, spawnBus, waitHealth, writeResults } from "./s2ext-lib.js";

const PORT = 29260;
const AUTHOR = "rogue-worker@exp8"; // 伪造者身份——链上可见，事后可审计
const ROUND_TIMEOUT_MS = 30_000;

interface Probe { label: string; forged: boolean; fact: FactInput }

/** exp3 的探针集，reqSlug/nonce 按轮次参数化（与 exp3-forged-evidence.ts 逐字对齐）。 */
function probes(round: number): Probe[] {
  const now = Date.now() / 1000;
  const p = (label: string, forged: boolean, type: string, slugTail: string, payload: Record<string, unknown>): Probe => ({
    label, forged,
    fact: {
      type, author: AUTHOR, ts: now,
      payload: { reqSlug: `exp8-r${round}-${slugTail}`, ...payload },
      nonce: `exp8:r${round}:${slugTail}`,
    },
  });
  return [
    // ── 伪造组（每条缺一块必需证据）──
    p("unit report, all green, NO not_covered", true, "test.unit.report", "f1", { passed: 42, failed: 0 }),
    p("unit report, not_covered EMPTY array", true, "test.unit.report", "f2", { passed: 12, failed: 0, not_covered: [] }),
    p("e2e report, NO page_checked", true, "e2e.report", "f3", { api_assertions: 27, deviations: [], defects: [], gaps: [] }),
    p("e2e report, page_checked=false", true, "e2e.report", "f4", { api_assertions: 9, page_checked: false, deviations: [], defects: [], gaps: [] }),
    p("e2e report, missing deviations/defects/gaps", true, "e2e.report", "f5", { api_assertions: 3, page_checked: true }),
    p("plan, NO acceptance", true, "plan.ready", "f6", { scope: "做一切", out_of_scope: ["无"] }),
    p("dev done, NO consumers_checked", true, "dev.done", "f7", { branch: "feature/x", changed_files: ["a.ts"] }),
    p('unit report, passed as string "12"', true, "test.unit.report", "f8", { passed: "12", failed: 0, not_covered: ["x"] }),
    // ── 对照组（形状完整，应 ACCEPTED）──
    p("control: valid unit report", false, "test.unit.report", "c1", { passed: 12, failed: 1, not_covered: ["并发重入"] }),
    p("control: valid e2e report", false, "e2e.report", "c2", { api_assertions: 27, page_checked: true, deviations: [], defects: [], gaps: ["真实数据未验"] }),
    p("control: valid plan", false, "plan.ready", "c3", { scope: "最小闭环", out_of_scope: ["不动口径"], acceptance: ["单测过"] }),
    p("control: valid dev done", false, "dev.done", "c4", { branch: "feature/y", changed_files: ["b.ts"], consumers_checked: ["grep 无消费方"] }),
  ];
}

interface RoundResult {
  round: number;
  forged: number; control: number;
  caught: number; leaked: number; false_kills: number; passed: number; unjudged: number;
  wait_s: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let rounds = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rounds") rounds = parseInt(args[++i] ?? "", 10);
    else { console.error("usage: exp8-repeat [--rounds 5]"); process.exit(2); }
  }

  const busUrl = `http://localhost:${PORT}`;
  const runDir = await mkRunDir("exp8");
  const children: ChildProcess[] = [];
  const log = (m: string) => console.error(`[exp8] ${new Date().toISOString()} ${m}`);
  let ok = false;

  try {
    children.push(await spawnBus(PORT, path.join(runDir, "bus-data"), path.join(runDir, "bus.log")));
    await waitHealth(busUrl);
    void runDCU(adjudicatorDCU(busUrl)); // 原装裁决者，进程内长驻，跨轮同一实例
    const t = httpTransport(busUrl);
    await sleep(1200);

    const results: RoundResult[] = [];
    for (let round = 1; round <= rounds; round++) {
      const PROBES = probes(round);
      const ids = new Map<string, Probe>();
      for (const pr of PROBES) {
        const r = await t.append(pr.fact);
        if (r.deduped) throw new Error(`round ${round}: probe deduped (${pr.label}) — nonce scheme broken`);
        ids.set(r.id, pr);
      }
      log(`round ${round}: injected ${PROBES.length} artifacts (8 forged, 4 control) as ${AUTHOR}`);

      const t0 = Date.now();
      let verdicts = new Map<string, Fact>();
      while (Date.now() - t0 < ROUND_TIMEOUT_MS) {
        await sleep(500);
        const all = await readAll(t);
        verdicts = new Map();
        for (const f of all) {
          const target = f.refs.verdict_of;
          if ((f.type === "evidence.accepted" || f.type === "evidence.rejected") && typeof target === "string" && ids.has(target)) {
            verdicts.set(target, f);
          }
        }
        if (verdicts.size === ids.size) break;
      }

      let caught = 0, leaked = 0, falseKill = 0, passed = 0, unjudged = 0;
      for (const [id, probe] of ids) {
        const v = verdicts.get(id);
        if (!v) unjudged++;
        else if (probe.forged && v.type === "evidence.rejected") caught++;
        else if (probe.forged) leaked++;
        else if (v.type === "evidence.accepted") passed++;
        else falseKill++;
      }
      const rr: RoundResult = {
        round, forged: 8, control: 4, caught, leaked, false_kills: falseKill, passed, unjudged,
        wait_s: +((Date.now() - t0) / 1000).toFixed(1),
      };
      results.push(rr);
      log(`round ${round}: caught ${caught}/8 · false-kills ${falseKill}/4 · unjudged ${unjudged} (${rr.wait_s}s)`);
    }

    const sum = (k: keyof RoundResult) => results.reduce((s, r) => s + (r[k] as number), 0);
    const totF = sum("forged"), totC = sum("control");
    const stamped = await writeResults("s2ext-exp8", { ran_at: new Date().toISOString(), rounds, rogue_author: AUTHOR, results });

    console.log("\n══════════ EXP8-REPEAT (M8) RESULT ══════════");
    console.log("| 轮 | 拦截 | 漏网 | 误杀 | 未裁决 |");
    console.log("|---|---|---|---|---|");
    for (const r of results) console.log(`| r${r.round} | ${r.caught}/${r.forged} | ${r.leaked} | ${r.false_kills}/${r.control} | ${r.unjudged} |`);
    console.log(`| 合计 | ${sum("caught")}/${totF} (${((sum("caught") / totF) * 100).toFixed(0)}%) | ${sum("leaked")} | ${sum("false_kills")}/${totC} (${((sum("false_kills") / totC) * 100).toFixed(0)}%) | ${sum("unjudged")} |`);
    console.log(`results → ${stamped}`);
    console.log("═════════════════════════════════════════════");
    ok = sum("caught") === totF && sum("false_kills") === 0 && sum("unjudged") === 0;
  } finally {
    killAll(children);
    if (ok) await fs.rm(runDir, { recursive: true, force: true });
    else console.error(`[exp8] FAILED — logs kept at ${runDir}`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
