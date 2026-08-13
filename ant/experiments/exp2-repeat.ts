/**
 * exp2-repeat.ts — S2 实验二的自动化重复轮（宪章 M6：断连恢复时延分布）。
 *
 * 每次迭代都是一个完整的 kill→过期→接管→完成 循环，全新总线 + 全新进程：
 *
 *   bus (29200+i)
 *   ├─ support 进程: plan/unittest/e2e DCU + adjudicator + gate-approver
 *   ├─ dev-a 进程:  dcu-dev@devchain      （dev 阶段，replica 0）
 *   └─ dev-b 进程:  dcu-dev-r1@devchain   （dev 阶段，replica 1，独立身份）
 *
 * harness 喂 1 条需求，盯事实流；谁先赢下 plan.ready 的认领，谁的进程就在
 * 它工作中途（4s 工时，Δ=6s > 工时）被 SIGKILL——无通知，无人可通知。
 * 之后只旁观：认领在总线时钟 recv+Δ 过期，幸存副本折叠出 open、重新认领、
 * 完成整条链。每次迭代记录接管时延（从过期时刻 / 从 kill 时刻两个口径）与
 * 双执行计数，汇总为 min/p50/p95/max 分布。
 *
 * 运行：cd ant && npx tsx experiments/exp2-repeat.ts [--n 10] [--delta 6]
 * 无 API key、无 docker；数据目录在 tmp，成功后清理。
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { httpTransport } from "@antlegion/bus/client";
import type { Fact } from "@antlegion/bus/types";
import { createRequirement } from "../src/req-new.js";
import { ARTIFACT_TYPES, foldDevchain } from "../src/folds/devchain.js";
import {
  dist, fmt, killAll, killTree, mkRunDir, readAll, sleep, spawnBus, spawnTsx, waitHealth, writeResults,
} from "./s2ext-lib.js";

const NODE_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "exp2-node.ts");
const BASE_PORT = 29200;
const ITER_TIMEOUT_MS = 120_000;

interface IterResult {
  iter: number;
  victim: string;
  survivor: string;
  /** harness 观察到认领 → 开枪的延迟（含轮询，必须 ≪ 工时）。 */
  claim_to_kill_s: number;
  /** 认领在总线时钟过期的时刻 − kill 时刻（≈ Δ − claim_to_kill）。 */
  kill_to_expiry_s: number;
  /** 幸存者接管认领（其 _.claim 的 recv）− 过期时刻 —— M6 的主口径。 */
  expiry_to_takeover_s: number;
  /** 幸存者接管 − kill 时刻。 */
  kill_to_takeover_s: number;
  /** 幸存者 resolve（_.resolve 的 recv）− kill 时刻。 */
  kill_to_resolve_s: number;
  /** 全链（4 阶段全 done）完成的墙钟时刻 − kill 时刻。 */
  kill_to_chain_done_s: number;
  double_executions: number;
}

async function runIteration(iter: number, delta: number): Promise<IterResult> {
  const port = BASE_PORT + iter;
  const busUrl = `http://localhost:${port}`;
  const runDir = await mkRunDir(`exp2-i${iter}`);
  const log = (m: string) => console.error(`[exp2 i${iter}] ${new Date().toISOString()} ${m}`);
  const children: ChildProcess[] = [];
  const byAuthor = new Map<string, ChildProcess>();
  const t = httpTransport(busUrl);
  let ok = false;

  try {
    children.push(await spawnBus(port, path.join(runDir, "bus-data"), path.join(runDir, "bus.log")));
    await waitHealth(busUrl);

    const commonEnv = { S2EXT_BUS_URL: busUrl, ANT_CLAIM_DELTA: String(delta) };
    const ws = path.join(runDir, "ws");
    await fs.mkdir(ws, { recursive: true });

    // support: other three stages + adjudicator + gate approver (one process)
    children.push(await spawnTsx(NODE_ENTRY, {
      ...commonEnv, S2EXT_WORKSPACE: ws, S2EXT_STAGES: "plan,unittest,e2e", S2EXT_SUPPORT: "1",
    }, path.join(runDir, "support.log")));
    // the two dev candidates — one OS process per identity, so kill -9 is a node crash
    const devA = await spawnTsx(NODE_ENTRY, {
      ...commonEnv, S2EXT_WORKSPACE: ws, S2EXT_STAGES: "dev", S2EXT_REPLICA: "0",
    }, path.join(runDir, "dev-a.log"));
    const devB = await spawnTsx(NODE_ENTRY, {
      ...commonEnv, S2EXT_WORKSPACE: ws, S2EXT_STAGES: "dev", S2EXT_REPLICA: "1",
    }, path.join(runDir, "dev-b.log"));
    children.push(devA, devB);
    byAuthor.set("dcu-dev@devchain", devA);
    byAuthor.set("dcu-dev-r1@devchain", devB);
    await sleep(1200); // let the DCUs register

    const slug = `exp2-i${String(iter).padStart(2, "0")}`;
    const req = await createRequirement(ws, `M6重复轮需求${iter}`, { slug });
    await t.append(req.fact);
    const t0 = Date.now();

    // ── phase 1: watch for the first dev claim on plan.ready, then shoot ──
    let planReadyId: string | null = null;
    let victimClaim: Fact | null = null;
    let tKill = NaN; // epoch seconds
    let victim = "", survivor = "";
    while (victimClaim === null) {
      if (Date.now() - t0 > ITER_TIMEOUT_MS) throw new Error("timed out waiting for the dev claim");
      await sleep(150);
      const facts = await readAll(t);
      if (!planReadyId) {
        const pr = facts.find((f) => f.type === "plan.ready" && f.payload.reqSlug === slug);
        if (pr) planReadyId = pr.id;
        else continue;
      }
      const claims = facts
        .filter((f) => f.type === "_.claim" && f.refs.claim_of === planReadyId)
        .sort((a, b) => a.seq - b.seq);
      if (claims.length === 0) continue;
      victimClaim = claims[0]!; // lowest seq = the §3.1 winner
      victim = victimClaim.author;
      survivor = victim === "dcu-dev@devchain" ? "dcu-dev-r1@devchain" : "dcu-dev@devchain";
      const proc = byAuthor.get(victim);
      if (!proc) throw new Error(`no process for claim winner ${victim}`);
      tKill = Date.now() / 1000;
      killTree(proc, "SIGKILL"); // whole process group — tsx wrapper AND the worker node

      log(`winner ${victim} claimed (seq ${victimClaim.seq}) — SIGKILL ${fmt(tKill - victimClaim.recv)}s after its claim recv`);
    }
    const claimToKill = tKill - victimClaim.recv;
    if (claimToKill > 3.5) throw new Error(`shot too late (${fmt(claimToKill)}s into a 4s act) — iteration invalid`);

    // ── phase 2: pure observation — expiry, takeover, resolve, chain done ──
    let takeoverClaim: Fact | null = null;
    let resolveFact: Fact | null = null;
    let facts: Fact[] = [];
    let chainDoneAt = NaN;
    for (;;) {
      if (Date.now() - t0 > ITER_TIMEOUT_MS) throw new Error("timed out waiting for takeover/completion");
      await sleep(300);
      facts = await readAll(t);
      // expiry anchor: the last live pre-kill claim on plan.ready (winner + a
      // possible same-tick losing claim expire together at max(recv)+Δ)
      const preKill = facts.filter((f) =>
        f.type === "_.claim" && f.refs.claim_of === planReadyId && f.recv <= tKill);
      const expiryAt = Math.max(...preKill.map((f) => f.recv)) + delta;
      takeoverClaim = facts.find((f) =>
        f.type === "_.claim" && f.refs.claim_of === planReadyId && f.author === survivor && f.recv > expiryAt) ?? null;
      resolveFact = facts.find((f) =>
        f.type === "_.resolve" && f.refs.resolves === planReadyId && f.author === survivor) ?? null;
      const view = foldDevchain(facts, { claimTimeout: delta }).find((v) => v.slug === slug);
      if (view?.done && takeoverClaim && resolveFact) { chainDoneAt = Date.now() / 1000; break; }
    }

    // exactly-once audit: >1 artifact for the same (req, stage) = double execution
    const perStage = new Map<string, number>();
    for (const f of facts) {
      if (!ARTIFACT_TYPES.has(f.type) || f.payload.reqSlug !== slug) continue;
      perStage.set(f.type, (perStage.get(f.type) ?? 0) + 1);
    }
    const doubleExec = [...perStage.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0);
    const victimResolved = facts.some((f) => f.type === "_.resolve" && f.refs.resolves === planReadyId && f.author === victim);
    if (victimResolved) throw new Error("victim resolved before dying — shot too late, iteration invalid");

    const preKill = facts.filter((f) =>
      f.type === "_.claim" && f.refs.claim_of === planReadyId && f.recv <= tKill);
    const expiryAt = Math.max(...preKill.map((f) => f.recv)) + delta;
    const r: IterResult = {
      iter, victim, survivor,
      claim_to_kill_s: +fmt(claimToKill),
      kill_to_expiry_s: +fmt(expiryAt - tKill),
      expiry_to_takeover_s: +fmt(takeoverClaim!.recv - expiryAt),
      kill_to_takeover_s: +fmt(takeoverClaim!.recv - tKill),
      kill_to_resolve_s: +fmt(resolveFact!.recv - tKill),
      kill_to_chain_done_s: +fmt(chainDoneAt - tKill),
      double_executions: doubleExec,
    };
    log(`takeover +${fmt(r.kill_to_takeover_s)}s after kill (${fmt(r.expiry_to_takeover_s)}s after expiry) · resolve +${fmt(r.kill_to_resolve_s)}s · chain done +${fmt(r.kill_to_chain_done_s)}s · double-exec ${doubleExec}`);
    ok = true;
    return r;
  } finally {
    killAll(children);
    if (ok) await fs.rm(runDir, { recursive: true, force: true });
    else console.error(`[exp2 i${iter}] FAILED — logs kept at ${runDir}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let n = 10;
  let delta = 6;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n") n = parseInt(args[++i] ?? "", 10);
    else if (args[i] === "--delta") delta = parseFloat(args[++i] ?? "");
    else { console.error("usage: exp2-repeat [--n 10] [--delta 6]"); process.exit(2); }
  }
  console.error(`[exp2] M6 repeat round: ${n} iterations, Δ=${delta}s, ports ${BASE_PORT}..${BASE_PORT + n - 1}`);

  const results: IterResult[] = [];
  for (let i = 0; i < n; i++) results.push(await runIteration(i, delta));

  const pick = (k: keyof IterResult) => results.map((r) => r[k] as number);
  const D = {
    expiry_to_takeover: dist(pick("expiry_to_takeover_s")),
    kill_to_takeover: dist(pick("kill_to_takeover_s")),
    kill_to_resolve: dist(pick("kill_to_resolve_s")),
    kill_to_chain_done: dist(pick("kill_to_chain_done_s")),
    claim_to_kill: dist(pick("claim_to_kill_s")),
  };
  const doubles = results.reduce((s, r) => s + r.double_executions, 0);

  const stamped = await writeResults("s2ext-exp2", { ran_at: new Date().toISOString(), n, delta_s: delta, distributions: D, iterations: results });

  console.log("\n══════════ EXP2-REPEAT (M6) RESULT ══════════");
  console.log(`iterations              ${n}  (kill -9 mid-act, Δ=${delta}s, 1 req × 4 stages each)`);
  console.log(`victims                 ${results.filter((r) => r.victim.endsWith("-r1@devchain")).length}× dcu-dev-r1, ${results.filter((r) => !r.victim.endsWith("-r1@devchain")).length}× dcu-dev`);
  const row = (label: string, d: { min: number; p50: number; p95: number; max: number }) =>
    console.log(`${label.padEnd(24)}min ${fmt(d.min)}  p50 ${fmt(d.p50)}  p95 ${fmt(d.p95)}  max ${fmt(d.max)}  (s)`);
  row("expiry → takeover", D.expiry_to_takeover);
  row("kill → takeover", D.kill_to_takeover);
  row("kill → resolve", D.kill_to_resolve);
  row("kill → chain done", D.kill_to_chain_done);
  row("claim → kill (装置)", D.claim_to_kill);
  console.log(`double executions       ${doubles} / ${n} iterations  ${doubles === 0 ? "✓ exactly-once held through every crash" : "✗ VIOLATED"}`);
  console.log(`results → ${stamped}`);
  console.log("═════════════════════════════════════════════");
  process.exit(doubles === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
