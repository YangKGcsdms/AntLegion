/**
 * v2 reader folds (PROTOCOL.md §3) — where meaning lives.
 *
 * Pure functions over the totally-ordered fact stream (bus.all()). Two readers
 * folding identically always agree, because they consume the same immutable,
 * recv-stamped, seq-ordered stream. The bus stores none of this.
 */

import type { Fact } from "./types.js";
import { RESERVED } from "./types.js";
import { globMatch } from "./canonical.js";

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

/**
 * The subject register (§3.3): every fact carrying `refs.subject == subject`,
 * in seq order — the full history of "what has been said about X", oldest first.
 * A reader accumulating multi-source observations reads this and does NOT
 * apply latest-wins; a reader who wants the current value calls `current`.
 */
export function history(stream: readonly Fact[], subject: string): Fact[] {
  return stream.filter((x) => x.refs.subject === subject).sort((a, b) => a.seq - b.seq);
}

/**
 * "What is X right now" — the current value of a subject register (§3.3),
 * folded identically by every reader from the same total order:
 *
 *   1. take the highest-seq fact in the `refs.subject` group;
 *   2. follow explicit `refs.supersedes` links forward (explicit replacement
 *      wins over group order, and the successor need not carry the subject);
 *   3. if the fact reached is tombstoned (§5.2) the register is *retracted* —
 *      the answer is null, not the previous value. Deleted is not superseded.
 *
 * Returns null for a subject nobody has ever written.
 */
export function current(stream: readonly Fact[], subject: string): Fact | null {
  const group = history(stream, subject);
  if (!group.length) return null;
  const byId = new Map(stream.map((x) => [x.id, x] as const));
  const seen = new Set<string>();
  let cur: Fact | undefined = group[group.length - 1];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const id: string = cur.id;
    const explicit = stream
      .filter((x) => x.refs.supersedes === id)
      .sort((a, b) => b.seq - a.seq);
    if (!explicit.length) break;
    cur = byId.get(explicit[0].id);
  }
  if (!cur) return null;
  const F = cur.id;
  const dead = stream.some((x) => x.type === RESERVED.TOMBSTONE && x.refs.tombstones === F);
  return dead ? null : cur;
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

/**
 * Everything F caused: every fact whose `refs.parent` chain leads back to F,
 * transitively, in seq order (F itself excluded). The forward view of §3.4 —
 * `causationChain` answers "how did this come to be", `descendants` answers
 * "what did this lead to". Both are pure folds over the same stream, so two
 * readers on two machines get the same answer.
 */
export function descendants(stream: readonly Fact[], F: string): Fact[] {
  const children = new Map<string, Fact[]>();
  for (const x of stream) {
    if (!x.refs.parent) continue;
    const list = children.get(x.refs.parent);
    if (list) list.push(x); else children.set(x.refs.parent, [x]);
  }
  const out: Fact[] = [];
  const seen = new Set<string>([F]);
  const queue = [F];
  while (queue.length) {
    const id = queue.shift()!;
    for (const c of children.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      queue.push(c.id);
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

// ─────────────────── §3.5 Colony registry & orphan facts ─────────────────────
//
// Closes the loop between what an agent LISTENS FOR and what it PUBLISHES. An
// agent announces itself with a `sys.registry` fact carrying `interests` (fact-
// type globs it consumes) and `publishes` (types it emits). Folding those
// declarations against the actual stream tells a supervisor three things a bare
// fact log can't: which fact types nobody is interested in (orphans — published
// into the void), which declared interests never see a matching fact (an agent
// waiting on silence), and which declared outputs never appear (a silent
// producer). All additive: no existing fold, wire shape, or vector changes.

/** The agent capability-declaration fact type (a convention, not a `_.` reserved op). */
export const SYS_REGISTRY = "sys.registry";

/** Types that are protocol mechanics or infrastructure, never "domain work" —
 *  excluded from orphan analysis (nobody declares interest in a `_.claim`).
 *  `context.*` is excluded for the same reason: it is the §3.6 clarification
 *  convention, and `contextGaps` already tracks whether a request was answered
 *  — a strictly better signal than "no agent declared interest in it". */
function isMechanicalType(t: string): boolean {
  return t.startsWith("_.") || t.startsWith("sys.") || t.startsWith("context.");
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string")
    : typeof v === "string" ? [v] : [];

export interface AgentRegistration {
  /** Trusted identity: the registry fact's author (never the payload's claim). */
  author: string;
  /** Fact-type globs this agent consumes/claims. */
  interests: string[];
  /** Fact types this agent emits. */
  publishes: string[];
  /** seq of the registration fact (latest wins per author). */
  seq: number;
  fact: Fact;
}

/**
 * Latest `sys.registry` per author → the live colony roster. Tolerant of the
 * devchain's legacy shape (`listens`/`produces`) as well as the general
 * `interests`/`publishes` arrays.
 */
export function colony(stream: readonly Fact[]): AgentRegistration[] {
  const latest = new Map<string, Fact>();
  for (const f of stream) {
    if (f.type !== SYS_REGISTRY) continue;
    const prev = latest.get(f.author);
    if (!prev || f.seq > prev.seq) latest.set(f.author, f);
  }
  const out: AgentRegistration[] = [];
  for (const f of latest.values()) {
    const p = f.payload as Record<string, unknown>;
    const interests = asStringArray(p.interests).concat(asStringArray(p.listens));
    const publishes = asStringArray(p.publishes).concat(asStringArray(p.produces));
    out.push({ author: f.author, interests: dedupe(interests), publishes: dedupe(publishes), seq: f.seq, fact: f });
  }
  return out.sort((a, b) => a.author.localeCompare(b.author));
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

export interface OrphanReport {
  /** Domain fact types no registered agent declares interest in. */
  orphanTypes: { type: string; count: number; sampleIds: string[] }[];
  /** Declared interests that match no fact in the stream (waiting on silence). */
  unmatchedInterests: { author: string; interest: string }[];
  /** Declared outputs the declaring agent never actually produced. */
  silentPublishes: { author: string; type: string }[];
  registeredAgents: number;
}

/**
 * Fold the colony roster against the stream to surface coordination gaps. A
 * fact type is an ORPHAN when no registered agent's interest glob matches it —
 * work published that nothing is set up to consume. With zero registrations
 * every domain type is (correctly) orphaned; a console should say "no agents
 * registered" in that case, which `registeredAgents === 0` signals.
 */
export function orphanReport(stream: readonly Fact[]): OrphanReport {
  const regs = colony(stream);
  const interestGlobs = regs.flatMap((r) => r.interests);

  // domain fact types actually present, with counts + a few sample ids
  const byType = new Map<string, { count: number; sampleIds: string[] }>();
  for (const f of stream) {
    if (isMechanicalType(f.type)) continue;
    const e = byType.get(f.type) ?? { count: 0, sampleIds: [] };
    e.count++;
    if (e.sampleIds.length < 3) e.sampleIds.push(f.id);
    byType.set(f.type, e);
  }

  const orphanTypes: OrphanReport["orphanTypes"] = [];
  for (const [type, e] of byType) {
    if (!interestGlobs.some((g) => globMatch(g, type))) {
      orphanTypes.push({ type, count: e.count, sampleIds: e.sampleIds });
    }
  }
  orphanTypes.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const streamTypes = [...new Set(stream.map((f) => f.type))];
  const unmatchedInterests: OrphanReport["unmatchedInterests"] = [];
  for (const r of regs) {
    for (const interest of r.interests) {
      if (!streamTypes.some((t) => globMatch(interest, t))) {
        unmatchedInterests.push({ author: r.author, interest });
      }
    }
  }

  const silentPublishes: OrphanReport["silentPublishes"] = [];
  for (const r of regs) {
    for (const type of r.publishes) {
      // "produced" = this same agent emitted a fact whose type matches the
      // declared output (glob-aware; the declaration may be a pattern).
      const produced = stream.some((f) => f.author === r.author && globMatch(type, f.type));
      if (!produced) silentPublishes.push({ author: r.author, type });
    }
  }

  return { orphanTypes, unmatchedInterests, silentPublishes, registeredAgents: regs.length };
}

// ──────────────── §3.6 Context-sufficiency loop (clarification) ───────────────
//
// A fact may assert "X is broken" without enough context for the agent that
// cares to act. Rather than let that dead-end silently, the interested agent
// publishes a `context.requested` fact (refs.about = the thin fact, payload
// .question) and any agent that can answer replies with `context.provided`
// (refs.parent = the request, payload.answer). `contextGaps` folds out the
// requests still waiting for an answer — the console surfaces them so a human
// or another agent can close the loop.

export const CONTEXT_REQUESTED = "context.requested";
export const CONTEXT_PROVIDED = "context.provided";

export interface ContextGap {
  request: Fact;
  /** The fact the requester found insufficient (refs.about). */
  about: string | null;
  question: string | null;
  answered: boolean;
  answers: Fact[];
}

/**
 * Open clarification requests: `context.requested` facts with no matching
 * `context.provided` (matched by refs.parent === request.id, or the explicit
 * refs.answers === request.id). Pass includeAnswered to get the full ledger.
 */
export function contextGaps(
  stream: readonly Fact[],
  opts: { includeAnswered?: boolean } = {},
): ContextGap[] {
  const provided = stream.filter((f) => f.type === CONTEXT_PROVIDED);
  const gaps: ContextGap[] = [];
  for (const request of stream) {
    if (request.type !== CONTEXT_REQUESTED) continue;
    const answers = provided
      .filter((p) => p.refs.parent === request.id || p.refs.answers === request.id)
      .sort((a, b) => a.seq - b.seq);
    const answered = answers.length > 0;
    if (answered && !opts.includeAnswered) continue;
    gaps.push({
      request,
      about: typeof request.refs.about === "string" ? request.refs.about : null,
      question: typeof (request.payload as { question?: unknown }).question === "string"
        ? (request.payload as { question: string }).question : null,
      answered,
      answers,
    });
  }
  return gaps;
}
