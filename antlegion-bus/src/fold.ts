/**
 * v2 reader folds (PROTOCOL.md §3) — where meaning lives.
 *
 * Pure functions over the totally-ordered fact stream (bus.all()). Two readers
 * folding identically always agree, because they consume the same immutable,
 * recv-stamped, seq-ordered stream. The bus stores none of this.
 */

import type { Fact } from "./types.js";
import { RESERVED } from "./types.js";

export type LifecycleState = "open" | "claimed" | "resolved" | "dead";
export interface Lifecycle {
  state: LifecycleState;
  owner: string | null; // claim winner / resolver
}

export interface FoldOpts {
  now?: number;          // evaluation wall-clock (unix s); defaults to real now
  claimTimeout?: number; // Δ seconds; default 600 (§8)
}

/** Facts whose refs touch F in any lifecycle-relevant way. */
function relevant(stream: readonly Fact[], F: string): Fact[] {
  return stream
    .filter(
      (f) =>
        f.refs.claim_of === F ||
        f.refs.resolves === F ||
        f.refs.release_of === F ||
        (f.type === RESERVED.TOMBSTONE && f.refs.tombstones === F),
    )
    .sort((a, b) => a.seq - b.seq);
}

interface ActiveClaim { author: string; seq: number; recv: number }

/**
 * Core ownership fold (§3.1): maintain the set of active claims with recv-anchored
 * deterministic expiry. `resolved`/`dead` are terminal. Only a trailing claim
 * with no successor uses wall-clock `now`.
 */
function ownership(stream: readonly Fact[], F: string, opts: FoldOpts): Lifecycle {
  const now = opts.now ?? Date.now() / 1000;
  const delta = opts.claimTimeout ?? 600;
  let active: ActiveClaim[] = [];

  for (const fact of relevant(stream, F)) {
    if (fact.type === RESERVED.TOMBSTONE) return { state: "dead", owner: null };
    // deterministic expiry: a claim is gone once a later fact's recv passes recv+Δ
    active = active.filter((c) => fact.recv <= c.recv + delta);
    if (fact.refs.claim_of === F) {
      active.push({ author: fact.author, seq: fact.seq, recv: fact.recv });
    } else if (fact.refs.release_of === F) {
      active = active.filter((c) => c.author !== fact.author);
    } else if (fact.refs.resolves === F) {
      const owner = active.length ? [...active].sort((a, b) => a.seq - b.seq)[0].author : null;
      if (owner === null || fact.author === owner) return { state: "resolved", owner };
    }
  }

  active = active.filter((c) => now <= c.recv + delta); // trailing expiry vs wall clock
  if (active.length) return { state: "claimed", owner: [...active].sort((a, b) => a.seq - b.seq)[0].author };
  return { state: "open", owner: null };
}

/** The author currently holding F's exclusive claim, or null. (§3.1) */
export function claimWinner(stream: readonly Fact[], F: string, opts: FoldOpts = {}): string | null {
  const o = ownership(stream, F, opts);
  return o.state === "claimed" || o.state === "resolved" ? o.owner : null;
}

/** Lifecycle state of F (§3.1). */
export function lifecycle(stream: readonly Fact[], F: string, opts: FoldOpts = {}): Lifecycle {
  return ownership(stream, F, opts);
}

/** Did `author` win the exclusive claim on F? (read-back confirmation, §3.1) */
export function didIWin(stream: readonly Fact[], F: string, author: string, opts: FoldOpts = {}): boolean {
  return claimWinner(stream, F, opts) === author;
}

// ───────────────────────────── §3.3 Supersession ─────────────────────────────

/**
 * The id of the fact that supersedes F (replaced it), or null. Explicit
 * (`refs.supersedes == F`) takes precedence; otherwise latest-wins within F's
 * `refs.subject` group. Tombstones (`refs.tombstones`) are NOT supersession —
 * a deleted fact is `dead`, not `superseded` (§5.2).
 */
export function supersededBy(stream: readonly Fact[], F: string): string | null {
  const explicit = stream
    .filter((x) => x.refs.supersedes === F)
    .sort((a, b) => a.seq - b.seq);
  if (explicit.length) return explicit[explicit.length - 1].id;

  const target = stream.find((x) => x.id === F);
  const subject = target?.refs.subject;
  if (target && subject) {
    const newer = stream
      .filter((x) => x.refs.subject === subject && x.seq > target.seq)
      .sort((a, b) => b.seq - a.seq);
    if (newer.length) return newer[0].id;
  }
  return null;
}

export function isSuperseded(stream: readonly Fact[], F: string): boolean {
  return supersededBy(stream, F) !== null;
}

// ─────────────────────────────── §3.2 Trust ──────────────────────────────────

export type TrustState =
  | "asserted" | "corroborated" | "consensus" | "contested" | "refuted" | "superseded";

/**
 * Trust of F folded from votes (§3.2). Ignores self-votes and counts only each
 * author's latest (highest-seq) vote. `superseded` (freshness) beats all.
 * `quorum` is the reader's policy — trust has no global value, so never use it
 * for coordination (§3.2); use exclusive claim (§3.1) for that.
 */
export function trust(stream: readonly Fact[], F: string, quorum = 2): TrustState {
  if (isSuperseded(stream, F)) return "superseded";

  const target = stream.find((x) => x.id === F);
  const latestByAuthor = new Map<string, Fact>();
  for (const v of stream.filter((x) => x.refs.vote === F).sort((a, b) => a.seq - b.seq)) {
    if (target && v.author === target.author) continue; // no self-votes
    latestByAuthor.set(v.author, v); // later seq overwrites → latest wins
  }

  let C = 0, X = 0;
  for (const v of latestByAuthor.values()) {
    const verdict = (v.payload as { verdict?: string }).verdict;
    if (verdict === "corroborate") C++;
    else if (verdict === "contradict") X++;
  }

  if (X >= quorum) return "refuted";
  if (X > 0) return "contested";
  if (C >= quorum) return "consensus";
  if (C > 0) return "corroborated";
  return "asserted";
}

// ───────────────────────────── §3.4 Causation ────────────────────────────────

/**
 * Walk `refs.parent` from F to its root, returned root→F. A compacted ancestor
 * keeps its skeleton (§5.2), so the chain shows a payload-stripped fact, never a
 * silent gap. Cycle-guarded (the bus rejects cycles at append, §5).
 */
export function causationChain(stream: readonly Fact[], F: string): Fact[] {
  const byId = new Map(stream.map((x) => [x.id, x] as const));
  const chain: Fact[] = [];
  const seen = new Set<string>();
  let cur = byId.get(F);
  while (cur && !seen.has(cur.id)) {
    chain.push(cur);
    seen.add(cur.id);
    cur = cur.refs.parent ? byId.get(cur.refs.parent) : undefined;
  }
  return chain.reverse();
}
