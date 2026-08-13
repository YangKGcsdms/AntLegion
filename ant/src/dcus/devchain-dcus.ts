/**
 * dcus/devchain-dcus.ts — the dev-chain DCU fleet (Step 3).
 *
 * Four stage DCUs + one adjudicator, all built on runDCU. Each stage DCU
 * knows exactly one sentence: "when the shared fold says my stage is `open`
 * for some requirement and nobody holds the claim, I claim it" — win the
 * claim, do the work, resolve the input with my artifact as a child. Losers
 * back off; crashed winners lose their claim after the §3.1 timeout and a
 * survivor re-runs. No DCU knows what step the pipeline is on: the chain is
 * a shape readers fold out of the stream afterwards.
 *
 * Workers are SIMULATED (deterministic payloads + a short sleep) — this step
 * validates the mechanics (claim / gate / adjudicate / chain). Swapping a
 * worker for a headless-agent spawn (`claude -p`, `codex exec`) changes only
 * the worker body; the bus contract stays identical.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { httpTransport } from "@antlegion/bus/client";
import type { DCUContext, DCUSpec } from "../runtime.js";
import { colonyAuthor, type IdentityConfig, type SpawnConfig } from "../config.js";
import { ACT_FAILED, runSpawnAct } from "./worker-spawn.js";
import { findExistingBySlug } from "../req-new.js";
import { watchdogDCU } from "./watchdog-dcu.js";
import { gateApproverDCU } from "./gate-approver.js";
import {
  ADJUDICATOR_AUTHOR, ARTIFACT_TYPES, DEVCHAIN, EVIDENCE_ACCEPTED, EVIDENCE_REJECTED,
  SYS_REGISTRY, STAGES, foldDevchain, pendingAdjudications,
  type ReqChainView, type Stage, type StageSpec,
} from "../folds/devchain.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulated work durations — long enough to watch the board move.
 * (Exported for the paired M1/M3 experiment so both arms share one budget.) */
export const WORK_MS: Record<Stage, number> = { plan: 2500, dev: 4000, unittest: 3000, e2e: 3500 };

/** Act mode: deterministic simulation (default), LLM content (ANT_WORKER=llm),
 * or a real headless agent in the colony folder (ANT_WORKER=spawn, 计划 13). */
export const workerMode = (): "simulated" | "llm" | "spawn" =>
  process.env.ANT_WORKER === "llm" ? "llm"
    : process.env.ANT_WORKER === "spawn" ? "spawn" : "simulated";

/** Fold options honoring ANT_CLAIM_DELTA (see runtime.ts) — the stage
 * predicate must expire stale claims at the same Δ the client uses. */
export function foldOpts(): { claimTimeout?: number } {
  const d = process.env.ANT_CLAIM_DELTA ? parseFloat(process.env.ANT_CLAIM_DELTA) : NaN;
  return Number.isFinite(d) && d > 0 ? { claimTimeout: d } : {};
}

// ── workers ──

export type Worker = (req: ReqChainView, ctx: DCUContext, workspaceRoot: string) => Promise<Record<string, unknown>>;

/**
 * Write a real docs/方案.md into the requirement dir (when it exists) so the
 * ingestor mirrors a doc.updated fact — the two boards corroborate each
 * other. Never overwrites an existing 方案.md.
 */
export async function writePlanDoc(
  req: ReqChainView, ctx: DCUContext, workspaceRoot: string,
  payload: { scope: string; out_of_scope: string[]; acceptance: string[] },
  generatedBy: string,
): Promise<void> {
  try {
    const dirname = await findExistingBySlug(workspaceRoot, req.slug);
    if (dirname) {
      const doc = path.join(workspaceRoot, dirname, "docs", "方案.md");
      await fs.mkdir(path.dirname(doc), { recursive: true });
      try {
        await fs.stat(doc); // exists — leave it alone
      } catch {
        await fs.writeFile(doc, [
          `# 方案：${req.name}`,
          "",
          "状态：方案待评审",
          "",
          `> 由 ${DEVCHAIN.plan.dcu} 生成（${generatedBy}）· 等待 H1 方案评审`,
          "",
          `## 范围`, payload.scope, "",
          `## 不做什么`, ...payload.out_of_scope.map((s) => `- ${s}`), "",
          `## 验收口径`, ...payload.acceptance.map((s) => `- ${s}`), "",
        ].join("\n"), "utf-8");
        ctx.log(`wrote ${doc}`);
      }
    }
  } catch (err) {
    ctx.log(`doc write skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}

const planWorker: Worker = async (req, ctx, workspaceRoot) => {
  const payload = {
    reqSlug: req.slug,
    doc: "docs/方案.md",
    scope: `实现「${req.name}」：按需求拆解出的最小闭环`,
    out_of_scope: ["不改动存量计算口径", "不引入新的外部依赖"],
    acceptance: ["单测通过且报告列明未覆盖项", "E2E 报告含偏差/缺陷/缺口三段且页面已验证"],
  };
  await writePlanDoc(req, ctx, workspaceRoot, payload, "simulated worker");
  return payload;
};

const devWorker: Worker = async (req) => ({
  reqSlug: req.slug,
  branch: `feature/${req.slug}`,
  changed_files: [
    `workflow-oa/src/main/java/.../${req.slug}/Service.java`,
    `workflow/src/views/${req.slug}/index.vue`,
  ],
  consumers_checked: ["grep 全部消费方：无既有调用点受影响（simulated）"],
});

const unittestWorker: Worker = async (req) => ({
  reqSlug: req.slug,
  passed: 12,
  failed: 0,
  not_covered: ["并发重入场景未覆盖", "外部依赖超时分支未覆盖（simulated）"],
});

const e2eWorker: Worker = async (req) => ({
  reqSlug: req.slug,
  api_assertions: 27,
  page_checked: true,
  deviations: [],
  defects: [],
  gaps: ["未在真实数据环境验证（H4 留给人工）"],
});

/** Exported for the paired M1/M3 experiment: the A-arm (isolated nodes, human
 * relay) runs these exact workers so the two arms differ only in the medium. */
export const SIM_WORKERS: Record<Stage, Worker> = {
  plan: planWorker, dev: devWorker, unittest: unittestWorker, e2e: e2eWorker,
};

/** Resolve the active worker set. LLM workers are imported lazily so the
 * simulated path never touches the LLM module (or requires an API key). */
async function activeWorkers(): Promise<Record<Stage, Worker>> {
  if (workerMode() !== "llm") return SIM_WORKERS;
  const m = await import("./workers-llm.js");
  return { plan: m.llmPlanWorker, dev: m.llmDevWorker, unittest: m.llmUnittestWorker, e2e: m.llmE2eWorker };
}

// ── registry fact (deterministic → dedups across restarts) ──

/**
 * Publish this DCU's sys.registry fact. Deterministic content (ts:0, stable
 * nonce) → same id on every restart → the bus dedups; registration IS the
 * act of publishing, no central registrar. Uses the raw transport because
 * ClientV2.publish stamps wall-clock ts, which would break content dedup.
 */
export async function publishRegistry(
  busUrl: string, author: string, spec: StageSpec | null,
  extra: Record<string, unknown>, log: (m: string) => void,
  identity?: IdentityConfig,
): Promise<void> {
  const colony = identity?.colony ?? "devchain";
  const r = await httpTransport(busUrl).append({
    type: SYS_REGISTRY,
    author,
    ts: 0,
    payload: {
      domain: "devchain",
      colony,
      dcu: author,
      worker: workerMode(),
      // General capability declaration (fold.ts §7): interests = fact types this
      // agent consumes, publishes = types it emits. Drives colony/orphan folds.
      // Kept alongside the devchain-specific stage/listens/produces fields.
      ...(spec ? {
        interests: [spec.listens], publishes: [spec.produces, ACT_FAILED],
        stage: spec.stage, order: spec.order, listens: spec.listens,
        produces: spec.produces, gate: spec.gate, skills: spec.skills,
        evidence_required: spec.evidence.required,
      } : {}),
      // Declared claim scope (计划 13 §三.2): readers fold these into the
      // colony directory; the claim predicate honors them client-side.
      ...(identity?.origins ? { origins: identity.origins } : {}),
      ...(identity?.filter ? { filter: identity.filter } : {}),
      ...extra,
    },
    // v3: declaration identity includes the colony; a changed declaration is a
    // NEW fact superseding the old one (latest per author wins in the fold).
    nonce: `registry:${colony}:${author}:v3`,
  });
  log(`registry ${r.deduped ? "deduped" : "published"} (seq ${r.seq})`);
}

// ── stage DCU ──

export interface StageDCUOpts {
  /** Colony identity: author suffix + claim scope (计划 13 §三). */
  identity?: IdentityConfig;
  /** Headless-agent act config; required when worker mode is "spawn". */
  spawn?: SpawnConfig;
  /** Colony root for spawn acts (default process.cwd()). */
  colonyRoot?: string;
}

export function stageDCU(
  stage: Stage, busUrl: string, workspaceRoot: string, replica = 0, opts: StageDCUOpts = {},
): DCUSpec {
  const spec = DEVCHAIN[stage];
  // Replicas are distinct identities racing for the same claims — that is
  // the point: exactly-once must hold under contention, not just solo.
  const baseAuthor = replica === 0 ? spec.dcu : `${spec.dcu.split("@")[0]}-r${replica}@devchain`;
  const author = colonyAuthor(baseAuthor, opts.identity?.colony);
  const colonyRoot = opts.colonyRoot ?? process.cwd();
  // spawn mode is single-concurrency per stage DCU: a colony agent works one
  // task at a time; while it runs the loop keeps folding but claims nothing.
  let actInFlight = false;
  return {
    name: author,
    author,
    busUrl,
    pollMs: 1000,
    init: async (ctx) => {
      await publishRegistry(busUrl, author, spec,
        replica > 0 ? { replica_of: spec.dcu } : {}, ctx.log, opts.identity);
    },
    onBatch: async (_batch, ctx) => {
      const views = foldDevchain(ctx.mirror, foldOpts());
      for (const req of views) {
        const mine = req.stages.find((s) => s.stage === stage);
        if (!mine || mine.state !== "open" || !mine.inputId) continue;
        if (!inClaimScope(req, opts.identity)) continue;

        const mode = workerMode();
        if (mode === "spawn" && actInFlight) break; // busy — claim nothing this pass

        // contested claim: lowest surviving seq wins; losers just move on.
        let won = false;
        try {
          const c = await ctx.client.claim(mine.inputId);
          won = c.won;
          if (!won) { ctx.log(`lost claim on ${req.slug} to ${c.winner}`); continue; }
        } catch (err) {
          ctx.log(`claim failed on ${req.slug}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        if (mode === "spawn") {
          // Act leaves the loop (计划 13 §二): the agent runs detached while
          // this DCU keeps polling/folding — a working colony must not go deaf.
          const inputFact = ctx.mirror.find((f) => f.id === mine.inputId);
          if (!inputFact || !opts.spawn) {
            ctx.log(`spawn act aborted on ${req.slug}: ${!inputFact ? "input fact not in mirror" : "no spawn config"}`);
            continue;
          }
          actInFlight = true;
          ctx.log(`claimed ${spec.listens} of ${req.slug} — spawn act starts (detached)`);
          void runSpawnAct({
            stage, spec, req: { slug: req.slug, name: req.name },
            inputFact, ctx, colonyRoot, cfg: opts.spawn,
            claimDeltaSec: foldOpts().claimTimeout ?? 600,
          })
            .catch((err) => ctx.log(`spawn act crashed: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => { actInFlight = false; });
          break; // one act at a time
        }

        if (mode === "simulated") {
          ctx.log(`claimed ${spec.listens} of ${req.slug} — working (${WORK_MS[stage]}ms, simulated)`);
          await sleep(WORK_MS[stage]);
        } else {
          ctx.log(`claimed ${spec.listens} of ${req.slug} — working (llm act)`);
        }
        const payload = await (await activeWorkers())[stage](req, ctx, workspaceRoot);

        try {
          await ctx.client.resolve(mine.inputId, [
            { type: spec.produces, payload, refs: { subject: req.slug } },
          ]);
          ctx.log(`resolved ${req.slug} → ${spec.produces}`);
        } catch (err) {
          // claim expired mid-work or a race — a survivor will redo it.
          ctx.log(`resolve failed on ${req.slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}

/**
 * Claim-scope predicate (计划 13 §三.2): a stage DCU only claims work whose
 * req fact carries a declared origin and passes the structured filter. Pure
 * client-side reading — the bus never gates anything.
 */
export function inClaimScope(
  req: { origin: string; reqFact: { payload: Record<string, unknown> } },
  identity?: IdentityConfig,
): boolean {
  if (identity?.origins && identity.origins.length > 0 && !identity.origins.includes(req.origin)) return false;
  if (identity?.filter) {
    // filter.path is a dot-path into the req fact's payload; strict equality.
    let v: unknown = req.reqFact.payload;
    for (const seg of identity.filter.path.split(".")) {
      if (typeof v !== "object" || v === null) return false;
      v = (v as Record<string, unknown>)[seg];
    }
    if (v !== identity.filter.eq) return false;
  }
  return true;
}

// ── adjudicator DCU ──

/**
 * Judges every artifact's evidence shape against the registry and publishes
 * the verdict. Downstream stages fold on the verdict, so an artifact missing
 * its evidence (e.g. a unit report without 未覆盖项) halts the chain — the
 * machine version of 做完了 ≠ 验证过了.
 */
/**
 * Governance teeth (计划 13 §三.2): fold the latest sys.registry per author
 * into a declared-produces map. An artifact whose type its author never
 * declared is `undeclared` — the adjudicator refuses it as evidence. Nothing
 * blocks the publish (append-only never gates); undeclared output just
 * cannot win trust.
 */
export function declaredProduces(facts: readonly { type: string; author: string; seq: number; payload: Record<string, unknown> }[]): Map<string, Set<string>> {
  const latest = new Map<string, { seq: number; produces: Set<string> }>();
  for (const f of facts) {
    if (f.type !== SYS_REGISTRY) continue;
    const prev = latest.get(f.author);
    if (prev && prev.seq > f.seq) continue;
    const declared = new Set<string>();
    for (const key of ["produces", "publishes"]) {
      const v = f.payload[key];
      if (typeof v === "string") declared.add(v);
      if (Array.isArray(v)) for (const t of v) if (typeof t === "string") declared.add(t);
    }
    latest.set(f.author, { seq: f.seq, produces: declared });
  }
  return new Map([...latest].map(([a, e]) => [a, e.produces]));
}

export function adjudicatorDCU(busUrl: string, identity?: IdentityConfig): DCUSpec {
  const author = colonyAuthor(ADJUDICATOR_AUTHOR, identity?.colony);
  return {
    name: author,
    author,
    busUrl,
    pollMs: 1000,
    init: async (ctx) => {
      await publishRegistry(busUrl, author, null, {
        role: "adjudicator",
        listens: [...ARTIFACT_TYPES.keys()],
        produces: [EVIDENCE_ACCEPTED, EVIDENCE_REJECTED],
        judges: Object.fromEntries(STAGES.map((s) => [DEVCHAIN[s].produces, DEVCHAIN[s].evidence.required])),
      }, ctx.log, identity);
    },
    onBatch: async (_batch, ctx) => {
      const produces = declaredProduces(ctx.mirror);
      for (const artifact of pendingAdjudications(ctx.mirror)) {
        const spec = ARTIFACT_TYPES.get(artifact.type)!;
        const undeclared = !(produces.get(artifact.author)?.has(artifact.type) ?? false);
        const missing = spec.evidence.check(artifact.payload);
        const accepted = !undeclared && missing.length === 0;
        await ctx.client.publish(
          accepted ? EVIDENCE_ACCEPTED : EVIDENCE_REJECTED,
          accepted
            ? { stage: spec.stage, checked: Object.keys(spec.evidence.required) }
            : undeclared
              ? { stage: spec.stage, missing, undeclared: true, reason: `越权产出：${artifact.author} 未声明 produces ${artifact.type} — 未声明的产出赢不了信任` }
              : { stage: spec.stage, missing, reason: `证据形状不合格：缺 ${missing.join(", ")}` },
          { refs: { verdict_of: artifact.id } },
        );
        ctx.log(`${accepted ? "ACCEPTED" : "REJECTED"} ${artifact.type} of ${String(artifact.payload.reqSlug ?? "?")}${accepted ? "" : undeclared ? " — undeclared producer" : ` — missing ${missing.join(",")}`}`);
        // No local bookkeeping needed: runDCU polls before onBatch, so the
        // verdict published here is mirrored before the next pending pass.
      }
    },
  };
}

/** The whole fleet, ready for Promise.all(runDCU). `replicas: 2` doubles
 * every stage DCU with distinct identities — a live exactly-once stress. */
export function devchainFleet(
  busUrl: string, workspaceRoot: string,
  opts: {
    autoGate?: boolean; replicas?: number; identity?: IdentityConfig;
    spawn?: SpawnConfig; colonyRoot?: string; heartbeatSec?: number;
  } = {},
): DCUSpec[] {
  const replicas = Math.max(1, opts.replicas ?? 1);
  const stageOpts: StageDCUOpts = {
    ...(opts.identity ? { identity: opts.identity } : {}),
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    ...(opts.colonyRoot ? { colonyRoot: opts.colonyRoot } : {}),
  };
  const fleet: DCUSpec[] = [];
  for (let r = 0; r < replicas; r++) {
    fleet.push(...STAGES.map((s) => stageDCU(s, busUrl, workspaceRoot, r, stageOpts)));
  }
  fleet.push(adjudicatorDCU(busUrl, opts.identity), watchdogDCU(busUrl, opts.identity, opts.heartbeatSec));
  if (opts.autoGate) fleet.push(gateApproverDCU(busUrl, opts.identity));
  if (opts.heartbeatSec !== undefined) for (const s of fleet) s.heartbeatSec = opts.heartbeatSec;
  return fleet;
}
