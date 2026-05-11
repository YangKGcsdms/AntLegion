/**
 * Acceptance filtering and priority arbitration.
 * Mirrors Python: filter.py
 *
 * Gate order (cheapest first):
 *   0. Ant health state
 *   1. Priority range
 *   2. Mode compatibility
 *   3. Semantic kind
 *   4. Epistemic state / confidence / superseded
 *   5. Content matching (capabilities, domains, type patterns)
 *   6. Subject key patterns
 */

import type { AntIdentity, Fact, FactMode } from "../types/protocol.js";
import { EPISTEMIC_RANK } from "../types/protocol.js";

export interface MatchResult {
  matched: boolean;
  capabilityOverlap: number;
  domainOverlap: number;
  typePatternHit: boolean;
  score: number;
}

function createMatchResult(): MatchResult {
  return {
    matched: false,
    capabilityOverlap: 0,
    domainOverlap: 0,
    typePatternHit: false,
    score: 0,
  };
}

/** Simple glob matcher (supports * and ?). */
export function globMatch(pattern: string, text: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return regex.test(text);
}

export function evaluateFilter(fact: Fact, ant: AntIdentity): MatchResult {
  const af = ant.acceptance_filter;
  const result = createMatchResult();

  // Gate 0: State check
  if (ant.state === "isolated" || ant.state === "offline") return result;

  // Gate 1: Priority range
  const [low, high] = af.priority_range;
  const effectivePriority = fact.effective_priority ?? fact.priority;
  if (effectivePriority < low || effectivePriority > high) return result;

  // Gate 2: Mode compatibility
  if (!af.modes.includes(fact.mode)) return result;

  // Gate 3: Semantic kind
  if (af.semantic_kinds.length > 0 && !af.semantic_kinds.includes(fact.semantic_kind)) {
    return result;
  }

  // Gate 4: Epistemic gates
  if (af.exclude_superseded && fact.epistemic_state === "superseded") return result;

  const factRank = EPISTEMIC_RANK[fact.epistemic_state] ?? 0;
  if (factRank < af.min_epistemic_rank) return result;

  const effConfidence = fact.confidence ?? 0.0;
  if (effConfidence < af.min_confidence) return result;

  // Gate 5: Content matching (at least one dimension must match)
  if (fact.need_capabilities.length > 0 && af.capability_offer.length > 0) {
    const capSet = new Set(af.capability_offer);
    result.capabilityOverlap = fact.need_capabilities.filter((c) =>
      capSet.has(c),
    ).length;
  }

  if (fact.domain_tags.length > 0 && af.domain_interests.length > 0) {
    const domSet = new Set(af.domain_interests);
    result.domainOverlap = fact.domain_tags.filter((d) => domSet.has(d)).length;
  }

  if (af.fact_type_patterns.length > 0) {
    result.typePatternHit = af.fact_type_patterns.some((p) =>
      globMatch(p, fact.fact_type),
    );
  }

  const contentMatched =
    result.capabilityOverlap > 0 ||
    result.domainOverlap > 0 ||
    result.typePatternHit;
  const noFilters =
    af.capability_offer.length === 0 &&
    af.domain_interests.length === 0 &&
    af.fact_type_patterns.length === 0;

  if (!contentMatched && !noFilters) return result;

  // Gate 6: Subject key patterns
  if (af.subject_key_patterns.length > 0 && fact.subject_key) {
    if (!af.subject_key_patterns.some((p) => globMatch(p, fact.subject_key))) {
      return result;
    }
  }

  result.matched = true;
  result.score = computeMatchScore(result, ant);
  return result;
}

function computeMatchScore(result: MatchResult, ant: AntIdentity): number {
  let score = 0;
  score += result.capabilityOverlap * 10;
  score += result.domainOverlap * 5;
  if (result.typePatternHit) score += 3;
  score *= ant.reliability_score;
  return score;
}

/**
 * Select which ant(s) should receive a fact.
 * BROADCAST: return all matched.
 * EXCLUSIVE: return single winner by score → reliability → ant_id.
 *
 * Accepts pre-scored candidates to avoid re-running evaluateFilter.
 */
export function arbitrate(
  fact: Fact,
  scoredCandidates: Array<{ ant: AntIdentity; score: number }>,
): AntIdentity[] {
  if (fact.mode === "broadcast") return scoredCandidates.map((s) => s.ant);
  if (scoredCandidates.length === 0) return [];

  const sorted = scoredCandidates
    .map((s) => ({
      score: s.score,
      reliability: s.ant.reliability_score,
      antId: s.ant.ant_id,
      ant: s.ant,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.reliability !== b.reliability) return b.reliability - a.reliability;
      return b.antId.localeCompare(a.antId);
    });

  return [sorted[0].ant];
}
