/**
 * folds/identity.ts — 身份冲突检测 (计划 13 §三.3, the S2 double-execution
 * incident made structural).
 *
 * A stateless bus cannot FORBID two processes from sharing an author, but a
 * reader fold can SEE it: every DCU heartbeat carries a per-boot instance
 * token; two distinct tokens both alive inside the window under one author
 * means a double-start. Detection instead of prevention — 违反必被看见.
 *
 * Pure functions over the stream; the watchdog publishes the conflict fact.
 */

import type { Fact } from "@antlegion/bus/types";
import { SYS_HEARTBEAT } from "../runtime.js";

export const IDENTITY_CONFLICT = "sys.identity.conflict";

export interface IdentityConflict {
  author: string;
  /** Sorted pair — the conflict's stable identity (dedup key). */
  tokens: [string, string];
  pairKey: string;
  /** Latest heartbeat fact id per token (refs for the conflict fact). */
  heartbeats: [string, string];
}

/** Stable key: one conflict fact per (author, token pair), ever. */
export const conflictPairKey = (author: string, a: string, b: string): string =>
  [author, ...[a, b].sort()].join("|");

/**
 * Fold heartbeats → double-started identities. A token is "alive" when its
 * latest heartbeat's bus-stamped recv is within `windowSec` of `nowSec`
 * (recv, never ts — author clocks are advisory). Window should be ≥ 2×
 * the heartbeat interval so one missed beat is not a false all-clear.
 */
export function detectIdentityConflicts(
  stream: readonly Fact[], windowSec: number, nowSec: number,
): IdentityConflict[] {
  // latest heartbeat per (author, instance token)
  const latest = new Map<string, Map<string, Fact>>();
  for (const f of stream) {
    if (f.type !== SYS_HEARTBEAT) continue;
    const token = typeof f.payload.instance === "string" ? f.payload.instance : null;
    if (!token) continue;
    const byToken = latest.get(f.author) ?? new Map<string, Fact>();
    const prev = byToken.get(token);
    if (!prev || f.recv > prev.recv) byToken.set(token, f);
    latest.set(f.author, byToken);
  }

  const out: IdentityConflict[] = [];
  for (const [author, byToken] of latest) {
    const alive = [...byToken.entries()]
      .filter(([, f]) => nowSec - f.recv <= windowSec)
      .sort(([a], [b]) => a.localeCompare(b));
    // every live pair is a conflict (usually exactly one pair)
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const [tokA, hbA] = alive[i]!;
        const [tokB, hbB] = alive[j]!;
        out.push({
          author,
          tokens: [tokA, tokB],
          pairKey: conflictPairKey(author, tokA, tokB),
          heartbeats: [hbA.id, hbB.id],
        });
      }
    }
  }
  return out;
}

/** Pair keys already reported — the publish-side dedup (restart-safe: folded, not remembered). */
export function reportedConflicts(stream: readonly Fact[]): Set<string> {
  const out = new Set<string>();
  for (const f of stream) {
    if (f.type === IDENTITY_CONFLICT && typeof f.payload.pair_key === "string") {
      out.add(f.payload.pair_key);
    }
  }
  return out;
}
