/**
 * folds/devchain.ts — the dev-chain worldview: registry + evidence shapes + fold.
 *
 * Maps Carter's requirement-dev-flow skill pipeline onto the bus as four
 * stage domains plus one cross-cutting adjudicator:
 *
 *   req.registered ─claim/resolve by dcu-plan─▶ plan.ready
 *     ─evidence.accepted─▶ [gate H1 方案评审 — human] ─claim by dcu-dev─▶ dev.done
 *     ─evidence.accepted─▶ claim by dcu-unittest ─▶ test.unit.report
 *     ─evidence.accepted─▶ claim by dcu-e2e ─▶ e2e.report ─evidence.accepted─▶ done
 *
 * Stage N's *input* is stage N-1's output fact: the DCU claims that fact
 * (exactly-once via §3.1) and resolves it with its own artifact as a child
 * (refs.parent — causation). The adjudicator judges every artifact's evidence
 * shape and publishes evidence.accepted / evidence.rejected (refs.verdict_of);
 * downstream stages only proceed on an accepted verdict — "resolve 不是宣告,
 * 是提交证据": an artifact with the wrong shape never advances the chain.
 *
 * The fold is pure and deterministic — DCUs and the board compute the same
 * chain state from the same stream.
 */

import type { Fact } from "@antlegion/bus/types";
import { lifecycle, type FoldOpts } from "@antlegion/bus/fold";

// ── fact types ──
export const PLAN_READY = "plan.ready";
export const DEV_DONE = "dev.done";
export const UNIT_REPORT = "test.unit.report";
export const E2E_REPORT = "e2e.report";
export const GATE_APPROVED = "gate.approved";       // refs.gate_of = artifact id
export const EVIDENCE_ACCEPTED = "evidence.accepted"; // refs.verdict_of = artifact id
export const EVIDENCE_REJECTED = "evidence.rejected"; // refs.verdict_of = artifact id
export const SYS_REGISTRY = "sys.registry";

export const STAGES = ["plan", "dev", "unittest", "e2e"] as const;
export type Stage = (typeof STAGES)[number];

/** What a payload must contain to count as valid evidence for its type. */
export interface EvidenceRule {
  /** Field name → human description (shown on the board / in reject reasons). */
  required: Record<string, string>;
  /** Return the list of violated field names (empty = valid). */
  check: (payload: Record<string, unknown>) => string[];
}

export interface StageSpec {
  stage: Stage;
  order: number;
  dcu: string;               // author identity on the bus
  /** Fact type this stage watches and claims (its input). */
  listens: string;
  /** Artifact fact type this stage produces (resolve child). */
  produces: string;
  /** Human gate that must approve the *input* artifact before claiming. */
  gate: string | null;
  /** Which of Carter's skills this stage compresses. */
  skills: string[];
  evidence: EvidenceRule;
}

const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const nonEmptyArr = (v: unknown): boolean => isArr(v) && v.length > 0;
const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/**
 * The dev-chain registry. Evidence rules encode the pipeline's core
 * discipline — 做完了 ≠ 验证过了 — as machine-checkable shape:
 * a unit report without 未覆盖项 is an invalid fact, not a passing one.
 */
export const DEVCHAIN: Record<Stage, StageSpec> = {
  plan: {
    stage: "plan", order: 0, dcu: "dcu-plan@devchain",
    listens: "req.registered", produces: PLAN_READY, gate: null,
    skills: ["requirement-breakdown", "codebase-research", "cross-system-solution"],
    evidence: {
      required: {
        scope: "范围（做什么）",
        out_of_scope: "不做什么（非空列表）",
        acceptance: "验收口径（非空列表）",
      },
      check: (p) => {
        const bad: string[] = [];
        if (!nonEmptyStr(p.scope)) bad.push("scope");
        if (!nonEmptyArr(p.out_of_scope)) bad.push("out_of_scope");
        if (!nonEmptyArr(p.acceptance)) bad.push("acceptance");
        return bad;
      },
    },
  },
  dev: {
    stage: "dev", order: 1, dcu: "dcu-dev@devchain",
    listens: PLAN_READY, produces: DEV_DONE, gate: "H1",
    skills: ["parallel-requirement-workspace", "requirement-dev-flow S3-S4"],
    evidence: {
      required: {
        branch: "开发分支",
        changed_files: "改动文件（非空列表）",
        consumers_checked: "消费方核查记录（改不变量前 grep 全部消费方）",
      },
      check: (p) => {
        const bad: string[] = [];
        if (!nonEmptyStr(p.branch)) bad.push("branch");
        if (!nonEmptyArr(p.changed_files)) bad.push("changed_files");
        if (!nonEmptyArr(p.consumers_checked)) bad.push("consumers_checked");
        return bad;
      },
    },
  },
  unittest: {
    stage: "unittest", order: 2, dcu: "dcu-unittest@devchain",
    listens: DEV_DONE, produces: UNIT_REPORT, gate: null,
    skills: ["springboot-jdk8-cli", "requirement-dev-flow S5"],
    evidence: {
      required: {
        passed: "通过数",
        failed: "失败数",
        not_covered: "没测什么（非空列表 — 缺这段 = 无效报告）",
      },
      check: (p) => {
        const bad: string[] = [];
        if (typeof p.passed !== "number") bad.push("passed");
        if (typeof p.failed !== "number") bad.push("failed");
        if (!nonEmptyArr(p.not_covered)) bad.push("not_covered");
        return bad;
      },
    },
  },
  e2e: {
    stage: "e2e", order: 3, dcu: "dcu-e2e@devchain",
    listens: UNIT_REPORT, produces: E2E_REPORT, gate: null,
    skills: ["integration-debugging", "requirement-dev-flow S6-S8"],
    evidence: {
      required: {
        api_assertions: "API 断言数",
        page_checked: "页面验证（必须为 true — 接口绿≠页面对）",
        deviations: "偏差段（数组,可空）",
        defects: "缺陷段（数组,可空）",
        gaps: "缺口段（数组,可空）",
      },
      check: (p) => {
        const bad: string[] = [];
        if (typeof p.api_assertions !== "number") bad.push("api_assertions");
        if (p.page_checked !== true) bad.push("page_checked");
        for (const k of ["deviations", "defects", "gaps"]) {
          if (!isArr(p[k])) bad.push(k);
        }
        return bad;
      },
    },
  },
};

export const ADJUDICATOR_AUTHOR = "dcu-adjudicator@devchain";

/** produces-type → stage spec (what the adjudicator judges). */
export const ARTIFACT_TYPES: ReadonlyMap<string, StageSpec> = new Map(
  STAGES.map((s) => [DEVCHAIN[s].produces, DEVCHAIN[s]]),
);

// ── fold ──

export type StageState =
  | "waiting"       // input artifact doesn't exist / upstream not accepted yet
  | "gated"         // claimable but the human gate hasn't approved
  | "open"          // claimable now
  | "working"       // input claimed, owner is working
  | "adjudicating"  // resolved, artifact published, verdict pending
  | "done"          // artifact accepted
  | "rejected";     // artifact rejected — chain halts here for rework

export interface Verdict {
  verdict: "accepted" | "rejected";
  by: string;
  seq: number;
  missing: string[];
}

export interface StageView {
  stage: Stage;
  state: StageState;
  /** Fact this stage claims (null while waiting on upstream). */
  inputId: string | null;
  /** Claim winner while working / resolver once resolved. */
  owner: string | null;
  /** The produced artifact fact, once resolved. */
  output: Fact | null;
  verdict: Verdict | null;
  /** For gated stages: the gate name + approver once approved. */
  gate: { name: string; approvedBy: string | null } | null;
}

export interface ReqChainView {
  slug: string;
  name: string;
  origin: string;
  reqFact: Fact;
  stages: StageView[];
  /** True once every stage is done. */
  done: boolean;
}

function verdictOf(facts: readonly Fact[], artifactId: string): Verdict | null {
  let latest: Fact | null = null;
  for (const f of facts) {
    if (f.refs.verdict_of !== artifactId) continue;
    if (f.type !== EVIDENCE_ACCEPTED && f.type !== EVIDENCE_REJECTED) continue;
    if (!latest || f.seq > latest.seq) latest = f;
  }
  if (!latest) return null;
  const missing = isArr(latest.payload.missing)
    ? latest.payload.missing.filter((m): m is string => typeof m === "string")
    : [];
  return {
    verdict: latest.type === EVIDENCE_ACCEPTED ? "accepted" : "rejected",
    by: latest.author, seq: latest.seq, missing,
  };
}

function gateApproverOf(facts: readonly Fact[], artifactId: string): string | null {
  for (const f of facts) {
    if (f.type === GATE_APPROVED && f.refs.gate_of === artifactId) return f.author;
  }
  return null;
}

/** First artifact of `type` produced from `inputId` (resolve child → refs.parent). */
function outputOf(facts: readonly Fact[], inputId: string, type: string): Fact | null {
  let first: Fact | null = null;
  for (const f of facts) {
    if (f.type === type && f.refs.parent === inputId && (!first || f.seq < first.seq)) first = f;
  }
  return first;
}

/**
 * Fold the stream into per-requirement chain views. Deterministic: every DCU
 * and the board agree. `opts` passes through to the §3.1 lifecycle fold
 * (claim timeout / evaluation clock).
 */
export function foldDevchain(facts: readonly Fact[], opts: FoldOpts = {}): ReqChainView[] {
  // First req.registered per slug wins (identity), matching folds/chain.ts.
  const reqBySlug = new Map<string, Fact>();
  for (const f of [...facts].sort((a, b) => a.seq - b.seq)) {
    if (f.type !== "req.registered") continue;
    const slug = typeof f.payload.slug === "string" ? f.payload.slug : "";
    if (slug && !reqBySlug.has(slug)) reqBySlug.set(slug, f);
  }

  const views: ReqChainView[] = [];
  for (const [slug, reqFact] of reqBySlug) {
    const stages: StageView[] = [];
    // The chain walks input → output: stage 0's input is the req fact itself.
    let input: Fact | null = reqFact;
    let upstreamDone = true;

    for (const stage of STAGES) {
      const spec = DEVCHAIN[stage];
      const view: StageView = {
        stage, state: "waiting", inputId: input?.id ?? null,
        owner: null, output: null, verdict: null,
        gate: spec.gate ? { name: spec.gate, approvedBy: null } : null,
      };

      if (!upstreamDone || !input) {
        view.inputId = null;
        stages.push(view);
        input = null;
        continue;
      }

      if (spec.gate) view.gate = { name: spec.gate, approvedBy: gateApproverOf(facts, input.id) };

      const life = lifecycle(facts as Fact[], input.id, opts);
      view.owner = life.owner;
      view.output = outputOf(facts, input.id, spec.produces);
      if (view.output) view.verdict = verdictOf(facts, view.output.id);

      if (view.output) {
        // Artifact exists — adjudication decides the stage.
        if (!view.verdict) view.state = "adjudicating";
        else if (view.verdict.verdict === "accepted") view.state = "done";
        else view.state = "rejected";
      } else if (life.state === "claimed") {
        view.state = "working";
      } else if (spec.gate && !view.gate?.approvedBy) {
        view.state = "gated";
      } else {
        // open — also covers a resolved input with no artifact yet (a crashed
        // resolver's claim expired; treat as waiting for the artifact).
        view.state = life.state === "resolved" ? "adjudicating" : "open";
      }

      upstreamDone = view.state === "done";
      input = view.output; // next stage claims this artifact
      stages.push(view);
    }

    views.push({
      slug,
      name: typeof reqFact.payload.name === "string" ? reqFact.payload.name : slug,
      origin: typeof reqFact.payload.origin === "string" ? reqFact.payload.origin : "",
      reqFact, stages,
      done: stages.every((s) => s.state === "done"),
    });
  }

  return views.sort((a, b) => a.reqFact.seq - b.reqFact.seq);
}

/**
 * Artifacts awaiting adjudication: judged types with no verdict yet.
 * The adjudicator acts on this; restart-safe because it re-derives from the
 * stream (no verdict fact → still pending).
 */
export function pendingAdjudications(facts: readonly Fact[]): Fact[] {
  const judged = new Set<string>();
  for (const f of facts) {
    if ((f.type === EVIDENCE_ACCEPTED || f.type === EVIDENCE_REJECTED) && f.refs.verdict_of) {
      judged.add(f.refs.verdict_of);
    }
  }
  return facts.filter((f) => ARTIFACT_TYPES.has(f.type) && !judged.has(f.id));
}
