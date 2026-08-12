/**
 * S2 实验三 — 伪造报告拦截率（forged evidence interception）.
 *
 * 向总线注入证据形状残缺的 stage 产物（全绿但缺 not_covered 的单测报告、
 * 缺 page_checked 的 E2E 报告……），由 dcu-adjudicator 依 sys.registry 里
 * 声明的证据形状裁决。拦截率 = rejected / forged，目标 100%；同时注入
 * 形状完整的对照组，误杀率目标 0%。
 *
 * 前置：一条总线 + 一个裁决者（`ant chain --dcus adjudicator`）。
 * 运行：npx tsx experiments/exp3-forged-evidence.ts
 */

import { httpTransport } from "@antlegion/bus/client";
import type { Fact, FactInput } from "@antlegion/bus/types";

const BUS = process.env.ANTLEGION_BUS_URL ?? "http://localhost:28090";
const AUTHOR = "rogue-worker@exp3"; // 伪造者身份——链上可见，事后可审计
const t = httpTransport(BUS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Probe { label: string; forged: boolean; fact: FactInput }

const now = () => Date.now() / 1000;

const PROBES: Probe[] = [
  // ── 伪造组（每条缺一块必需证据）──
  { label: "unit report, all green, NO not_covered", forged: true, fact: {
    type: "test.unit.report", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-f1", passed: 42, failed: 0 } } },
  { label: "unit report, not_covered EMPTY array", forged: true, fact: {
    type: "test.unit.report", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-f2", passed: 12, failed: 0, not_covered: [] } } },
  { label: "e2e report, NO page_checked", forged: true, fact: {
    type: "e2e.report", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-f3", api_assertions: 27, deviations: [], defects: [], gaps: [] } } },
  { label: "e2e report, page_checked=false", forged: true, fact: {
    type: "e2e.report", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-f4", api_assertions: 9, page_checked: false, deviations: [], defects: [], gaps: [] } } },
  { label: "e2e report, missing deviations/defects/gaps", forged: true, fact: {
    type: "e2e.report", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-f5", api_assertions: 3, page_checked: true } } },
  { label: "plan, NO acceptance", forged: true, fact: {
    type: "plan.ready", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-f6", scope: "做一切", out_of_scope: ["无"] } } },
  { label: "dev done, NO consumers_checked", forged: true, fact: {
    type: "dev.done", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-f7", branch: "feature/x", changed_files: ["a.ts"] } } },
  { label: "unit report, passed as string \"12\"", forged: true, fact: {
    type: "test.unit.report", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-f8", passed: "12", failed: 0, not_covered: ["x"] } } },
  // ── 对照组（形状完整，应 ACCEPTED）──
  { label: "control: valid unit report", forged: false, fact: {
    type: "test.unit.report", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-c1", passed: 12, failed: 1, not_covered: ["并发重入"] } } },
  { label: "control: valid e2e report", forged: false, fact: {
    type: "e2e.report", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-c2", api_assertions: 27, page_checked: true, deviations: [], defects: [], gaps: ["真实数据未验"] } } },
  { label: "control: valid plan", forged: false, fact: {
    type: "plan.ready", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-c3", scope: "最小闭环", out_of_scope: ["不动口径"], acceptance: ["单测过"] } } },
  { label: "control: valid dev done", forged: false, fact: {
    type: "dev.done", author: AUTHOR, ts: now(),
    payload: { reqSlug: "exp3-c4", branch: "feature/y", changed_files: ["b.ts"], consumers_checked: ["grep 无消费方"] } } },
];

async function main(): Promise<number> {
  try { await fetch(`${BUS}/health`); } catch {
    console.error(`bus unreachable at ${BUS} — start one, plus: ant chain --dcus adjudicator`);
    return 1;
  }

  const ids = new Map<string, Probe>();
  for (const p of PROBES) {
    const r = await t.append(p.fact);
    ids.set(r.id, p);
  }
  console.log(`injected ${PROBES.length} artifacts (${PROBES.filter((p) => p.forged).length} forged, ${PROBES.filter((p) => !p.forged).length} control) as ${AUTHOR}`);

  // wait for the adjudicator to fold + verdict everything
  const deadline = Date.now() + 30000;
  let verdicts = new Map<string, Fact>();
  while (Date.now() < deadline) {
    await sleep(1500);
    const all: Fact[] = [];
    let cursor = 0;
    for (;;) {
      const page = await t.read({ since: cursor, limit: 500 });
      if (page.length === 0) break;
      for (const f of page) { all.push(f); if (f.seq > cursor) cursor = f.seq; }
      if (page.length < 500) break;
    }
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
  console.log("");
  for (const [id, probe] of ids) {
    const v = verdicts.get(id);
    const verdict = v ? (v.type === "evidence.rejected" ? "REJECTED" : "ACCEPTED") : "—no verdict—";
    const missing = v?.type === "evidence.rejected" ? ` (missing: ${(v.payload as { missing?: string[] }).missing?.join(",")})` : "";
    let mark: string;
    if (!v) { unjudged++; mark = "⏳"; }
    else if (probe.forged && verdict === "REJECTED") { caught++; mark = "✓ caught"; }
    else if (probe.forged) { leaked++; mark = "✗ LEAKED"; }
    else if (verdict === "ACCEPTED") { passed++; mark = "✓ passed"; }
    else { falseKill++; mark = "✗ FALSE-KILL"; }
    console.log(`  ${mark.padEnd(12)} ${verdict.padEnd(13)} ${probe.label}${missing}`);
  }

  const forgedN = PROBES.filter((p) => p.forged).length;
  const controlN = PROBES.length - forgedN;
  console.log(`\n══════════ EXP3 RESULT ══════════`);
  console.log(`interception   ${caught}/${forgedN}  (${((caught / forgedN) * 100).toFixed(0)}%)`);
  console.log(`false kills    ${falseKill}/${controlN}`);
  console.log(`unjudged       ${unjudged}`);
  console.log(`═════════════════════════════════`);
  return caught === forgedN && falseKill === 0 && unjudged === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
