/**
 * exp5-clock-skew.ts — M5 时钟偏移容忍轮（宪章 .cowork/11 §M5 的隔离场景子项）。
 *
 * 被测属性（PROTOCOL.md §3.1）：所有时间性折叠只看总线盖章的 `recv`，作者自报
 * 的 `ts` 是纯咨询字段——一台节点时钟拨快/拨慢 5 分钟，认领过期、胜者判定、
 * 生命周期折叠必须与时钟正常的对照轮逐字节一致。
 *
 * 装置：三条独立总线（三臂），同一份确定性编排脚本逐字重放，唯一差异是
 * `worker-skew@exp5` 这个身份的 ts 字段加偏移：
 *
 *   control 臂: skew = 0        fast 臂: skew = +300s        slow 臂: skew = −300s
 *
 * 每臂三个工作单元（Δ = 2s）：
 *   U1 竞争:      skew 先认领、honest 后认领 → 胜者必须 = skew（最小 seq，与 ts 无关）
 *   U2 过期边界:  skew 认领后放置；在 claim.recv+1.0s 评估 = claimed，+2.5s = open
 *                （过期时刻锚在 recv+Δ，哪怕作者的 ts 声称自己在 5 分钟外）
 *   U3 崩溃接管:  skew 认领 → 真实等 3s（>Δ）→ honest 认领（其 recv 即过期证明）
 *                → skew 僵尸 resolve（必须被折叠忽略）→ honest resolve 生效
 *
 * 三臂各自把折叠结果投影成 canonical JSON，逐字节比较 + sha256。附带自证：
 * 偏移臂 skew 身份的 ts−recv 均值 ≈ ±300s（偏移真实存在），事实 id 与对照臂
 * 不同（内容寻址下输入确实不同——一致的只是折叠语义）。
 *
 * 运行：cd ant && npx tsx experiments/exp5-clock-skew.ts
 */

import path from "node:path";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { httpTransport } from "@antlegion/bus/client";
import { claimWinner, lifecycle } from "@antlegion/bus/fold";
import type { AppendResult, Fact, Refs } from "@antlegion/bus/types";
import {
  fmt, killAll, mkRunDir, readAll, sleep, spawnBus, waitHealth, writeResults,
} from "./s2ext-lib.js";
import { promises as fs } from "node:fs";

const BASE_PORT = 29240;
const DELTA = 2; // claim-expiry Δ (s) for every fold in this round
const SKEW_AUTHOR = "worker-skew@exp5";
const HONEST_AUTHOR = "worker-honest@exp5";

interface ProbeRow { unit: string; probe: string; value: string }

interface ArmResult {
  arm: string;
  skew_s: number;
  rows: ProbeRow[];
  canonical: string;
  sha256: string;
  facts_total: number;
  /** mean(ts − recv) over the skewed identity's facts — proves the skew is real. */
  skew_ts_minus_recv_mean_s: number;
  /** ids of the skewed identity's facts (content-addressed → must differ across arms). */
  skew_fact_ids: string[];
}

async function runArm(arm: string, skew: number, port: number): Promise<ArmResult> {
  const busUrl = `http://localhost:${port}`;
  const runDir = await mkRunDir(`exp5-${arm}`);
  const log = (m: string) => console.error(`[exp5 ${arm}] ${new Date().toISOString()} ${m}`);
  const children: ChildProcess[] = [];
  let ok = false;

  try {
    children.push(await spawnBus(port, path.join(runDir, "bus-data"), path.join(runDir, "bus.log")));
    await waitHealth(busUrl);
    const t = httpTransport(busUrl);

    // A skewed author stamps ts from its own (wrong) clock; honest from the real one.
    const pub = (author: string, type: string, payload: Record<string, unknown>, refs?: Refs): Promise<AppendResult> =>
      t.append({
        type, author, payload, ...(refs ? { refs } : {}),
        ts: Date.now() / 1000 + (author === SKEW_AUTHOR ? skew : 0),
      });

    const rows: ProbeRow[] = [];
    const life = (facts: Fact[], F: string, now?: number) =>
      lifecycle(facts, F, { claimTimeout: DELTA, ...(now !== undefined ? { now } : {}) });
    const show = (l: { state: string; owner: string | null }) => `${l.state}/${l.owner ?? "-"}`;

    // ── U1 竞争胜者 ──
    const T1 = await pub(HONEST_AUTHOR, "task.item", { unit: "U1" });
    const c1s = await pub(SKEW_AUTHOR, "_.claim", {}, { claim_of: T1.id });
    const c1h = await pub(HONEST_AUTHOR, "_.claim", {}, { claim_of: T1.id });
    {
      const facts = await readAll(t);
      const beforeResolve = facts.filter((f) => f.seq <= c1h.seq);
      rows.push({
        unit: "U1", probe: "winner-under-contention@bothclaims+0.2s",
        value: claimWinner(beforeResolve, T1.id, { claimTimeout: DELTA, now: c1h.recv + 0.2 }) ?? "-",
      });
    }
    await pub(SKEW_AUTHOR, "_.resolve", {}, { resolves: T1.id });

    // ── U2 过期边界（recv 锚定,确定性评估点）──
    const T2 = await pub(HONEST_AUTHOR, "task.item", { unit: "U2" });
    const c2s = await pub(SKEW_AUTHOR, "_.claim", {}, { claim_of: T2.id });

    // ── U3 过期接管 + 僵尸 resolve ──
    const T3 = await pub(HONEST_AUTHOR, "task.item", { unit: "U3" });
    const c3s = await pub(SKEW_AUTHOR, "_.claim", {}, { claim_of: T3.id });
    log(`U3 claim by ${SKEW_AUTHOR} (recv ${fmt(c3s.recv)}) — waiting ${DELTA + 1}s of real time so the next claim's recv proves expiry`);
    await sleep((DELTA + 1) * 1000);
    const c3h = await pub(HONEST_AUTHOR, "_.claim", {}, { claim_of: T3.id });
    await pub(SKEW_AUTHOR, "_.resolve", { note: "zombie resolve after expiry — must be ignored" }, { resolves: T3.id });
    await pub(HONEST_AUTHOR, "_.resolve", {}, { resolves: T3.id });

    // ── fold everything ──
    const facts = await readAll(t);
    rows.push({ unit: "U1", probe: "final-lifecycle", value: show(life(facts, T1.id)) });
    rows.push({ unit: "U2", probe: `lifecycle@claim+1.0s (Δ=${DELTA})`, value: show(life(facts, T2.id, c2s.recv + 1.0)) });
    rows.push({ unit: "U2", probe: `lifecycle@claim+2.5s (Δ=${DELTA})`, value: show(life(facts, T2.id, c2s.recv + 2.5)) });
    rows.push({ unit: "U3", probe: "post-expiry-winner@takeover+0.2s", value: (() => {
      const beforeResolves = facts.filter((f) => f.seq <= c3h.seq);
      return claimWinner(beforeResolves, T3.id, { claimTimeout: DELTA, now: c3h.recv + 0.2 }) ?? "-";
    })() });
    rows.push({ unit: "U3", probe: "final-lifecycle (zombie resolve ignored?)", value: show(life(facts, T3.id)) });
    rows.sort((a, b) => (a.unit + a.probe).localeCompare(b.unit + b.probe));

    const canonical = JSON.stringify(rows);
    const skewFacts = facts.filter((f) => f.author === SKEW_AUTHOR);
    const drift = skewFacts.reduce((s, f) => s + (f.ts - f.recv), 0) / (skewFacts.length || 1);
    // self-check: the skew must actually be on the wire
    if (Math.abs(drift - skew) > 2) throw new Error(`skew not applied? mean(ts−recv)=${fmt(drift)}s, wanted ≈${skew}s`);

    ok = true;
    return {
      arm, skew_s: skew, rows, canonical,
      sha256: createHash("sha256").update(canonical).digest("hex"),
      facts_total: facts.length,
      skew_ts_minus_recv_mean_s: +fmt(drift),
      skew_fact_ids: skewFacts.map((f) => f.id),
    };
  } finally {
    killAll(children);
    if (ok) await fs.rm(runDir, { recursive: true, force: true });
    else console.error(`[exp5 ${arm}] FAILED — logs kept at ${runDir}`);
  }
}

async function main(): Promise<void> {
  const arms: Array<[string, number]> = [["control", 0], ["fast+300s", 300], ["slow-300s", -300]];
  const results: ArmResult[] = [];
  for (let i = 0; i < arms.length; i++) {
    const [name, skew] = arms[i]!;
    console.error(`[exp5] ── arm ${name} (skew ${skew}s) ──`);
    results.push(await runArm(name, skew, BASE_PORT + i));
  }

  const [control, fast, slow] = results as [ArmResult, ArmResult, ArmResult];
  const identical = control.canonical === fast.canonical && control.canonical === slow.canonical;
  const idsDiffer =
    fast.skew_fact_ids.every((id) => !control.skew_fact_ids.includes(id)) &&
    slow.skew_fact_ids.every((id) => !control.skew_fact_ids.includes(id));

  const stamped = await writeResults("s2ext-exp5", {
    ran_at: new Date().toISOString(), delta_s: DELTA,
    fold_outputs_identical: identical, skew_fact_ids_differ: idsDiffer, arms: results,
  });

  console.log("\n══════════ EXP5 CLOCK-SKEW (M5) RESULT ══════════");
  console.log(`| 折叠探针 | control | fast(+300s) | slow(−300s) |`);
  console.log(`|---|---|---|---|`);
  for (let i = 0; i < control.rows.length; i++) {
    const r = control.rows[i]!;
    console.log(`| ${r.unit} ${r.probe} | ${r.value} | ${fast.rows[i]!.value} | ${slow.rows[i]!.value} |`);
  }
  console.log(`\nmean(ts−recv) of ${SKEW_AUTHOR}:  control ${fmt(control.skew_ts_minus_recv_mean_s)}s · fast ${fmt(fast.skew_ts_minus_recv_mean_s)}s · slow ${fmt(slow.skew_ts_minus_recv_mean_s)}s  (偏移真实在事实里)`);
  console.log(`skewed-author fact ids differ from control: ${idsDiffer ? "yes (content-addressed — inputs genuinely differed)" : "NO"}`);
  console.log(`fold projection sha256:`);
  for (const r of results) console.log(`  ${r.arm.padEnd(12)} ${r.sha256}`);
  console.log(`byte-for-byte identical: ${identical ? "✓ YES — folds never saw the author clock" : "✗ NO — DIVERGENCE"}`);
  console.log(`results → ${stamped}`);
  console.log("═════════════════════════════════════════════════");
  process.exit(identical && idsDiffer ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
