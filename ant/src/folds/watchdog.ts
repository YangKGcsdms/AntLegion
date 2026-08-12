/**
 * folds/watchdog.ts — the watchdog's worldview: exceptions, not progress.
 *
 * Pure detection over the stream + the devchain fold. The watchdog DCU is the
 * single writer of exception facts; the board only displays them. Three
 * conditions map to the supervision model's "例外收件箱":
 *
 *   starved     a stage is `open` (claimable) but nobody claimed it for
 *               STARVED_AFTER_S — the domain has no live worker, or its
 *               trigger predicate is wrong.
 *   escalation  the machine can't chew this one — either an artifact's
 *               evidence was REJECTED (rework needs a human decision), or the
 *               same input burned ≥ ESCALATE_CLAIMS claims without a resolve
 *               (crash-looping workers: a poison pill).
 *
 * Gated stages are NOT detected here — waiting for a human IS their normal
 * state; the board folds them into the inbox directly.
 *
 * Idempotency: detections are keyed on the input/artifact fact id; the caller
 * skips anything already published (mirror check), so each condition fires
 * exactly one fact.
 */

import type { Fact } from "@antlegion/bus/types";
import type { ReqChainView } from "./devchain.js";
import { EVIDENCE_REJECTED } from "./devchain.js";

export const CHAIN_STARVED = "chain.starved";       // refs.starves = input fact id
export const ESCALATE_HUMAN = "escalate.human";     // refs.escalates = input/artifact fact id
export const WATCHDOG_AUTHOR = "dcu-watchdog@devchain";

/** Demo-friendly defaults; production would read these from config. */
export const STARVED_AFTER_S = 60;
export const ESCALATE_CLAIMS = 3;

export interface StarvedItem {
  reqSlug: string;
  stage: string;
  /** The claimable input fact nobody claimed. */
  inputId: string;
  openForS: number;
}

export interface EscalationItem {
  reqSlug: string;
  stage: string;
  /** evidence_rejected → the artifact id; claim_churn → the input id. */
  factId: string;
  reason: "evidence_rejected" | "claim_churn";
  detail: string;
}

const byId = (facts: readonly Fact[]) => new Map(facts.map((f) => [f.id, f] as const));

/**
 * Stages sitting `open` past the threshold. The anchor is the recv of the
 * *latest prerequisite* (input artifact / its verdict / the gate approval) —
 * the moment the stage actually became claimable, not when the requirement
 * was born.
 */
export function detectStarved(
  facts: readonly Fact[],
  views: readonly ReqChainView[],
  nowSec: number,
  thresholdS = STARVED_AFTER_S,
): StarvedItem[] {
  const idx = byId(facts);
  const out: StarvedItem[] = [];
  for (const v of views) {
    for (const s of v.stages) {
      if (s.state !== "open" || !s.inputId) continue;
      const input = idx.get(s.inputId);
      if (!input) continue;
      let anchor = input.recv;
      for (const f of facts) {
        if (f.refs.verdict_of === s.inputId || f.refs.gate_of === s.inputId) {
          anchor = Math.max(anchor, f.recv);
        }
      }
      const openForS = nowSec - anchor;
      if (openForS > thresholdS) {
        out.push({ reqSlug: v.slug, stage: s.stage, inputId: s.inputId, openForS: Math.round(openForS) });
      }
    }
  }
  return out;
}

/**
 * Conditions a machine shouldn't keep retrying:
 * - an artifact whose evidence was rejected (the stage shows `rejected`);
 * - an input that's `open` again after ≥ ESCALATE_CLAIMS distinct claims
 *   (every worker that touched it died — poison pill).
 */
export function detectEscalations(
  facts: readonly Fact[],
  views: readonly ReqChainView[],
  claimLimit = ESCALATE_CLAIMS,
): EscalationItem[] {
  const out: EscalationItem[] = [];
  for (const v of views) {
    for (const s of v.stages) {
      if (s.state === "rejected" && s.output && s.verdict) {
        out.push({
          reqSlug: v.slug, stage: s.stage, factId: s.output.id,
          reason: "evidence_rejected",
          detail: `证据被拒：缺 ${s.verdict.missing.join(", ") || "?"}`,
        });
      }
      if (s.state === "open" && s.inputId) {
        const claims = facts.filter((f) => f.refs.claim_of === s.inputId).length;
        if (claims >= claimLimit) {
          out.push({
            reqSlug: v.slug, stage: s.stage, factId: s.inputId,
            reason: "claim_churn",
            detail: `${claims} 次认领全部过期未产出 — 疑似毒丸`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Rejected artifacts that are NOT part of any chain stage (e.g. a stray or
 * hand-published artifact the adjudicator shot down). They never surface as a
 * stage state, but a human should still see them.
 */
export function detectOrphanRejections(
  facts: readonly Fact[],
  views: readonly ReqChainView[],
): EscalationItem[] {
  const inChain = new Set<string>();
  for (const v of views) {
    for (const s of v.stages) if (s.output) inChain.add(s.output.id);
  }
  const idx = byId(facts);
  const out: EscalationItem[] = [];
  for (const f of facts) {
    if (f.type !== EVIDENCE_REJECTED || !f.refs.verdict_of || inChain.has(f.refs.verdict_of)) continue;
    const artifact = idx.get(f.refs.verdict_of);
    if (!artifact) continue;
    const missing = Array.isArray(f.payload.missing) ? f.payload.missing.join(", ") : "?";
    out.push({
      reqSlug: typeof artifact.payload.reqSlug === "string" ? artifact.payload.reqSlug : "?",
      stage: typeof f.payload.stage === "string" ? f.payload.stage : "?",
      factId: artifact.id,
      reason: "evidence_rejected",
      detail: `游离 artifact（不在任何链上）被拒：缺 ${missing}`,
    });
  }
  return out;
}

/** Fact ids already covered by a published watchdog fact (for idempotency). */
export function alreadyReported(facts: readonly Fact[]): Set<string> {
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.type === CHAIN_STARVED && f.refs.starves) seen.add(f.refs.starves);
    if (f.type === ESCALATE_HUMAN && f.refs.escalates) seen.add(f.refs.escalates);
  }
  return seen;
}
