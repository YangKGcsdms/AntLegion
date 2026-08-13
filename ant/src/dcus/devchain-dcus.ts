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
import { findExistingBySlug } from "../req-new.js";
import { watchdogDCU } from "./watchdog-dcu.js";
import { gateApproverDCU } from "./gate-approver.js";
import {
  ADJUDICATOR_AUTHOR, ARTIFACT_TYPES, DEVCHAIN, EVIDENCE_ACCEPTED, EVIDENCE_REJECTED,
  SYS_REGISTRY, STAGES, foldDevchain, pendingAdjudications,
  type ReqChainView, type Stage, type StageSpec,
} from "../folds/devchain.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulated work durations — long enough to watch the board move. */
const WORK_MS: Record<Stage, number> = { plan: 2500, dev: 4000, unittest: 3000, e2e: 3500 };

/** Act mode: deterministic simulation (default) or LLM content (ANT_WORKER=llm). */
export const workerMode = (): "simulated" | "llm" =>
  process.env.ANT_WORKER === "llm" ? "llm" : "simulated";

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

const SIM_WORKERS: Record<Stage, Worker> = {
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
): Promise<void> {
  const r = await httpTransport(busUrl).append({
    type: SYS_REGISTRY,
    author,
    ts: 0,
    payload: {
      domain: "devchain",
      dcu: author,
      worker: workerMode(),
      // General capability declaration (fold.ts §7): interests = fact types this
      // agent consumes, publishes = types it emits. Drives colony/orphan folds.
      // Kept alongside the devchain-specific stage/listens/produces fields.
      ...(spec ? {
        interests: [spec.listens], publishes: [spec.produces],
        stage: spec.stage, order: spec.order, listens: spec.listens,
        produces: spec.produces, gate: spec.gate, skills: spec.skills,
        evidence_required: spec.evidence.required,
      } : {}),
      ...extra,
    },
    nonce: `registry:devchain:${author}:v2`,
  });
  log(`registry ${r.deduped ? "deduped" : "published"} (seq ${r.seq})`);
}

// ── stage DCU ──

export function stageDCU(stage: Stage, busUrl: string, workspaceRoot: string, replica = 0): DCUSpec {
  const spec = DEVCHAIN[stage];
  // Replicas are distinct identities racing for the same claims — that is
  // the point: exactly-once must hold under contention, not just solo.
  const author = replica === 0 ? spec.dcu : `${spec.dcu.split("@")[0]}-r${replica}@devchain`;
  return {
    name: author,
    author,
    busUrl,
    pollMs: 1000,
    init: async (ctx) => {
      await publishRegistry(busUrl, author, spec, replica > 0 ? { replica_of: spec.dcu } : {}, ctx.log);
    },
    onBatch: async (_batch, ctx) => {
      const views = foldDevchain(ctx.mirror, foldOpts());
      for (const req of views) {
        const mine = req.stages.find((s) => s.stage === stage);
        if (!mine || mine.state !== "open" || !mine.inputId) continue;

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

        const mode = workerMode();
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

// ── adjudicator DCU ──

/**
 * Judges every artifact's evidence shape against the registry and publishes
 * the verdict. Downstream stages fold on the verdict, so an artifact missing
 * its evidence (e.g. a unit report without 未覆盖项) halts the chain — the
 * machine version of 做完了 ≠ 验证过了.
 */
export function adjudicatorDCU(busUrl: string): DCUSpec {
  return {
    name: ADJUDICATOR_AUTHOR,
    author: ADJUDICATOR_AUTHOR,
    busUrl,
    pollMs: 1000,
    init: async (ctx) => {
      await publishRegistry(busUrl, ADJUDICATOR_AUTHOR, null, {
        role: "adjudicator",
        listens: [...ARTIFACT_TYPES.keys()],
        produces: [EVIDENCE_ACCEPTED, EVIDENCE_REJECTED],
        judges: Object.fromEntries(STAGES.map((s) => [DEVCHAIN[s].produces, DEVCHAIN[s].evidence.required])),
      }, ctx.log);
    },
    onBatch: async (_batch, ctx) => {
      for (const artifact of pendingAdjudications(ctx.mirror)) {
        const spec = ARTIFACT_TYPES.get(artifact.type)!;
        const missing = spec.evidence.check(artifact.payload);
        const accepted = missing.length === 0;
        await ctx.client.publish(
          accepted ? EVIDENCE_ACCEPTED : EVIDENCE_REJECTED,
          accepted
            ? { stage: spec.stage, checked: Object.keys(spec.evidence.required) }
            : { stage: spec.stage, missing, reason: `证据形状不合格：缺 ${missing.join(", ")}` },
          { refs: { verdict_of: artifact.id } },
        );
        ctx.log(`${accepted ? "ACCEPTED" : "REJECTED"} ${artifact.type} of ${String(artifact.payload.reqSlug ?? "?")}${accepted ? "" : ` — missing ${missing.join(",")}`}`);
        // No local bookkeeping needed: runDCU polls before onBatch, so the
        // verdict published here is mirrored before the next pending pass.
      }
    },
  };
}

/** The whole fleet, ready for Promise.all(runDCU). `replicas: 2` doubles
 * every stage DCU with distinct identities — a live exactly-once stress. */
export function devchainFleet(
  busUrl: string, workspaceRoot: string, opts: { autoGate?: boolean; replicas?: number } = {},
): DCUSpec[] {
  const replicas = Math.max(1, opts.replicas ?? 1);
  const fleet: DCUSpec[] = [];
  for (let r = 0; r < replicas; r++) {
    fleet.push(...STAGES.map((s) => stageDCU(s, busUrl, workspaceRoot, r)));
  }
  fleet.push(adjudicatorDCU(busUrl), watchdogDCU(busUrl));
  if (opts.autoGate) fleet.push(gateApproverDCU(busUrl));
  return fleet;
}
