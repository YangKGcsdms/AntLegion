/**
 * Reader folds (PROTOCOL.md §3) — where meaning lives.
 *
 * Pure functions over the totally-ordered fact stream (bus.all()). Two readers
 * folding identically always agree, because they consume the same immutable,
 * recv-stamped, seq-ordered stream. The bus stores none of this.
 *
 * **Domain.** Every fold here is a function of a *complete prefix* of the log:
 * all facts with 1 ≤ seq ≤ N. Folding a filtered, sampled or gap-containing
 * window is permitted but yields a non-normative approximation, and this module
 * does not distinguish the two — the caller must.
 *
 * The four questions of §0.7, in the order an isolated agent actually asks them:
 * what is X right now (§3.1), how did it come to be and what did it lead to
 * (§3.2), should I believe it (§3.3), who is responsible for it (§3.4).
 * Ownership is last because it is a corollary, not the purpose.
 */

import type { Fact } from "./types.js";
import { RESERVED, isReservedType } from "./types.js";
import { globMatch } from "./canonical.js";

/**
 * A fold was asked for a normative result it cannot compute from the prefix it
 * was given (§3, preamble). Returning a plausible answer instead would be the
 * worse failure: it is indistinguishable from a real one.
 */
export class FoldDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoldDomainError";
  }
}

const bySeq = (a: Fact, b: Fact): number => a.seq - b.seq;

/**
 * Retraction (§5.3): a `_.tombstone` naming `x`, **from x's own author**.
 *
 * The author gate is the whole point. In v2.0 any author could tombstone any
 * fact, and the effect was unusually destructive — the target's lifecycle went
 * `dead` (terminal), its register folded to null, and compaction was then
 * entitled to destroy its payload. That is a protocol-sanctioned data-
 * destruction primitive available to every writer. Retraction is now what it
 * should be: taking back your own statement.
 *
 * A stranger's tombstone is not nothing — a reader MAY surface it as a
 * *requested* retraction — but it does not retract.
 */
export function retracted(stream: readonly Fact[], x: Fact): boolean {
  return stream.some(
    (t) => t.type === RESERVED.TOMBSTONE && t.refs.tombstones === x.id && t.author === x.author,
  );
}

/** `retracted` by id, for callers holding an id rather than a fact. */
export function isRetracted(stream: readonly Fact[], F: string): boolean {
  const target = stream.find((x) => x.id === F);
  return target ? retracted(stream, target) : false;
}

// ─────────────────── §3.1 What is X right now — the register ──────────────────

/**
 * The subject register (§3.1): every fact carrying `refs.subject == subject`,
 * in seq order — the full history of what has been said about X, oldest first.
 *
 * Reserved-namespace facts (§1.4) are **not** members. Tagging a `_.tombstone`
 * with `refs.subject` is a natural mistake, and without this rule the retraction
 * itself becomes `current(S)` and simultaneously supersedes the fact it
 * retracts. A tombstone retracts through `refs.tombstones` alone.
 *
 * Latest-wins is one reader policy, not the only one: a reader accumulating
 * multi-source observations reads `history` and does not collapse it.
 */
export function history(stream: readonly Fact[], subject: string): Fact[] {
  return stream
    .filter((x) => x.refs.subject === subject && !isReservedType(x.type))
    .sort(bySeq);
}

/**
 * "What is X right now" — the current value of a subject register (§3.1):
 * the highest-seq member of `history(S)`, or null if that member has been
 * retracted by its author.
 *
 * **Retraction is not rollback.** A retracted head folds to null — *nothing is
 * currently known* — never to the previous value. Resurrecting an older
 * statement would assert something no author currently asserts.
 *
 * A fact that wants to become the current value of S MUST carry
 * `refs.subject: S`. v2.0 let an explicit successor become `current(S)` without
 * carrying the subject, so `current(S) ∉ history(S)` was reachable and the two
 * folds disagreed about which facts were live. To say what X is now, say it
 * *about X*.
 */
export function current(stream: readonly Fact[], subject: string): Fact | null {
  const group = history(stream, subject);
  if (!group.length) return null;
  const head = group[group.length - 1];
  return retracted(stream, head) ? null : head;
}

/**
 * The fact that **immediately** replaced F, or null (§3.1).
 *
 * Candidates are the authorized explicit successors (`refs.supersedes == F`
 * from F's own author) union the next members of F's register; the winner is
 * the **lowest** seq among them, not the newest. "What replaced F" is the next
 * statement; the latest statement is `current(S)`. Following `supersededBy`
 * repeatedly walks the register forward one step at a time.
 *
 * Three gates, each closing something v2.0 left open:
 *
 * - **Only an author may supersede their own fact.** Because `superseded`
 *   outranks every vote in §3.3, an ungated `supersedes` let any author silence
 *   any fact's trust state with a single append.
 * - **A retracted successor supersedes nothing** — otherwise retracting a bad
 *   replacement would leave the original permanently superseded with nothing
 *   current in its place.
 * - **Ties break by `seq`,** which is total, so there is never a choice.
 *
 * Returns null when F is not in the prefix (the author gate cannot be evaluated
 * without F, and guessing is worse than declining), and null when F has been
 * retracted (§5.3: retracted and superseded are different, and a fold MUST NOT
 * blur them).
 */
export function supersededBy(stream: readonly Fact[], F: string): string | null {
  const target = stream.find((x) => x.id === F);
  if (!target) return null;
  // A retracted fact is never `superseded` (§5.3): the two are different things
  // and folds MUST tell them apart. Its author took it back — nothing replaced
  // it, and reporting a successor would let a reader show a retraction as a
  // hand-off.
  if (retracted(stream, target)) return null;

  const explicit = stream.filter(
    (x) => x.refs.supersedes === F && x.author === target.author && !retracted(stream, x),
  );
  const subject = target.refs.subject;
  const next = subject
    ? history(stream, subject).filter((x) => x.seq > target.seq && !retracted(stream, x))
    : [];

  const candidates = new Map<string, Fact>();
  for (const x of [...explicit, ...next]) candidates.set(x.id, x);
  if (candidates.size === 0) return null;
  return [...candidates.values()].sort(bySeq)[0].id;
}

export function isSuperseded(stream: readonly Fact[], F: string): boolean {
  return supersededBy(stream, F) !== null;
}

// ──────────── §3.2 How did this come to be, what did it lead to ───────────────

/**
 * An unresolved `refs.parent` reached while walking a trail (§3.2). Surfaced
 * explicitly, never silently skipped: a truncated chain that looks complete
 * turns "I could not see the origin" into "this is the origin".
 */
export interface TrailGap {
  gap: true;
  /** The parent id that is not in this prefix. */
  missing: string;
}

export type TrailNode = Fact | TrailGap;

export const isGap = (n: TrailNode): n is TrailGap => (n as TrailGap).gap === true;

/**
 * Walk `refs.parent` from F to its root, returned root→F (§3.2). If the walk
 * reaches a parent that is not in the prefix, the chain begins with a
 * `TrailGap` naming it, so a caller can tell an unseen origin from a real root.
 *
 * For an F that is not in the prefix the chain is empty — the trail above an
 * unseen fact is not knowable, and F MUST NOT be reported as a root.
 *
 * Bounded by a visited set: §6.2's argument that cycles are unconstructible
 * holds for facts appended through a conforming bus, and folds also run over
 * exported, replicated and hand-repaired logs.
 */
export function causationChain(stream: readonly Fact[], F: string): TrailNode[] {
  const byId = new Map(stream.map((x) => [x.id, x] as const));
  const chain: TrailNode[] = [];
  const seen = new Set<string>();
  let cur = byId.get(F);
  while (cur && !seen.has(cur.id)) {
    chain.push(cur);
    seen.add(cur.id);
    const parentId = cur.refs.parent;
    if (!parentId) break;
    const parent = byId.get(parentId);
    if (!parent) { chain.push({ gap: true, missing: parentId }); break; }
    cur = parent;
  }
  return chain.reverse();
}

/** The facts of a chain, gaps dropped — for callers that only want the ancestry. */
export function causationFacts(stream: readonly Fact[], F: string): Fact[] {
  return causationChain(stream, F).filter((n): n is Fact => !isGap(n));
}

/** `|chain(F)|` counting facts only; a fact with no parent has depth 1 (§3.2). */
export function depth(stream: readonly Fact[], F: string): number {
  return causationFacts(stream, F).length;
}

/**
 * Everything F caused: every fact whose `refs.parent` chain reaches F,
 * transitively, in seq order (F itself excluded). The forward view of §3.2.
 *
 * Defined even for an F that is not in the prefix — the facts naming F as
 * parent are still knowable. The trail below an unseen fact is visible; the
 * trail above it is not.
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
  return out.sort(bySeq);
}

// ─────────────────────── §3.3 Should I believe it — trust ─────────────────────

export type TrustState =
  | "asserted" | "corroborated" | "consensus" | "contested" | "refuted"
  | "superseded" | "retracted";

const VERDICTS = new Set(["corroborate", "contradict"]);

/**
 * Trust of F folded from `_.vote` facts (§3.3). Self-votes are ignored and only
 * each author's **latest** vote counts, so a voter who changes their mind is
 * never double-counted.
 *
 * Three v2.0 defects are closed here:
 *
 * - `retracted` is a distinct state. v2.0 had none, so a tombstoned fact could
 *   fold to `consensus`.
 * - `quorum` MUST be ≥ 1. `quorum = 0` made every unvoted fact `refuted`.
 * - A vote whose `verdict` is missing or unrecognized is excluded from the
 *   tally **entirely**, rather than occupying its author's slot. In v2.0 a later
 *   junk vote silently cancelled that author's earlier valid one.
 *
 * **Trust has no global value, so never coordinate on it.** `quorum` is the
 * reader's policy, so two readers may legitimately disagree; the bus does not
 * adjudicate. Anything all participants must agree on is built on §3.4.
 *
 * A quorum counts distinct `author` strings, and `author` is self-asserted
 * (§5.4): on a bus that does not authenticate writers, one writer manufactures
 * any state at any quorum, and a reader MUST treat every state above `asserted`
 * as unverified.
 *
 * @throws FoldDomainError if F is not in the prefix — self-votes cannot be
 *   identified without F, which is why a filtered window is not foldable.
 */
export function trust(stream: readonly Fact[], F: string, quorum = 2): TrustState {
  if (!Number.isInteger(quorum) || quorum < 1) {
    throw new RangeError(`trust: quorum MUST be an integer ≥ 1, got ${quorum}`);
  }
  const target = stream.find((x) => x.id === F);
  if (!target) {
    throw new FoldDomainError(`trust: ${F} is not in the prefix; a trust result MUST NOT be returned`);
  }

  if (retracted(stream, target)) return "retracted";   // the author took it back
  if (isSuperseded(stream, F)) return "superseded";    // freshness beats confidence

  const latestByAuthor = new Map<string, Fact>();
  for (const v of stream.filter((x) => x.type === RESERVED.VOTE && x.refs.vote === F).sort(bySeq)) {
    if (v.author === target.author) continue;                       // no self-votes
    if (!VERDICTS.has((v.payload as { verdict?: string }).verdict ?? "")) continue; // junk never takes the slot
    if (retracted(stream, v)) continue;                             // a taken-back vote is no vote
    latestByAuthor.set(v.author, v);                                // later seq overwrites
  }

  let C = 0, X = 0;
  for (const v of latestByAuthor.values()) {
    if ((v.payload as { verdict: string }).verdict === "corroborate") C++;
    else X++;
  }

  if (X >= quorum) return "refuted";
  if (X > 0) return "contested";
  if (C >= quorum) return "consensus";
  if (C > 0) return "corroborated";
  return "asserted";
}

// ────────────────── §3.4 Who is responsible for it — ownership ────────────────

export type LifecycleState = "open" | "claimed" | "resolved" | "dead";
export interface Lifecycle {
  state: LifecycleState;
  owner: string | null; // claim winner / resolver
}

export interface FoldOpts {
  /** Evaluation wall-clock (unix s); defaults to real now. Advisory branch only. */
  now?: number;
  /**
   * Δ in seconds. **A property of the log, not the reader** (§3.4, §8): take it
   * from the bus's `/info` and do not substitute your own. A reader that folds
   * with a different Δ is non-conforming and the exclusivity guarantee does not
   * hold for it — in v2.0 Δ was a per-reader knob, and two readers with
   * different values disagreed not only about who held a claim but about
   * whether the work was resolved at all.
   */
  claimTimeout?: number;
}

/** Facts whose refs touch F in any lifecycle-relevant way, in seq order. */
function relevant(stream: readonly Fact[], F: string): Fact[] {
  return stream
    .filter(
      (f) =>
        f.refs.claim_of === F ||
        f.refs.resolves === F ||
        f.refs.release_of === F ||
        (f.type === RESERVED.TOMBSTONE && f.refs.tombstones === F),
    )
    .sort(bySeq);
}

interface ActiveClaim { author: string; seq: number; recv: number }

const lowestSeq = (claims: ActiveClaim[]): ActiveClaim | null =>
  claims.length ? [...claims].sort((a, b) => a.seq - b.seq)[0] : null;

/**
 * The ownership fold (§3.4): maintain the set of live claims with recv-anchored
 * deterministic expiry. `resolved` and `dead` are terminal.
 *
 * **Why expiry keys on `recv`.** A claim times out when time has provably
 * advanced past `claim.recv + Δ`, and wherever a later fact exists the proof is
 * that fact's own bus-stamped `recv` — identical for every reader, so the fold
 * is deterministic. Only a *trailing* claim with no successor falls back to
 * wall-clock `now`, and that branch is **advisory**: it can turn `claimed(a)`
 * into `open` and, where several claims trail, change which author is reported.
 * A reader needing a stable answer waits for the next fact, which settles it for
 * everyone at once.
 *
 * **To resolve, first claim.** A `resolves: F` is honoured only from F's current
 * claim winner. v2.0's ungated path — anyone may resolve a never-claimed fact —
 * was a denial primitive: `resolved` is terminal, so one well-formed fact from
 * any writer closed any never-claimed item permanently, and the fold could not
 * tell it from a real completion.
 */
function ownership(stream: readonly Fact[], F: string, opts: FoldOpts): Lifecycle {
  const now = opts.now ?? Date.now() / 1000;
  const delta = opts.claimTimeout ?? 600;
  const target = stream.find((x) => x.id === F);
  let active: ActiveClaim[] = [];

  for (const fact of relevant(stream, F)) {
    // Retraction is terminal — but only from the target's own author (§5.1).
    // A stranger's tombstone is not a retraction and must not kill the fact.
    if (fact.type === RESERVED.TOMBSTONE) {
      if (target && fact.author === target.author) return { state: "dead", owner: null };
      continue;
    }

    // Deterministic expiry: a claim is gone once a later fact's recv passes recv+Δ.
    active = active.filter((c) => fact.recv <= c.recv + delta);

    if (fact.refs.claim_of === F) {
      active.push({ author: fact.author, seq: fact.seq, recv: fact.recv });
    } else if (fact.refs.release_of === F) {
      // Honoured only from an author actually holding a live claim (§5.1).
      if (active.some((c) => c.author === fact.author)) {
        active = active.filter((c) => c.author !== fact.author);
      }
    } else if (fact.refs.resolves === F) {
      const owner = lowestSeq(active);
      if (owner && fact.author === owner.author) return { state: "resolved", owner: owner.author };
      // otherwise NOT honoured: only the current claim winner may resolve.
    }
  }

  active = active.filter((c) => now <= c.recv + delta); // trailing expiry, advisory
  const winner = lowestSeq(active);
  return winner ? { state: "claimed", owner: winner.author } : { state: "open", owner: null };
}

/** Lifecycle state of F (§3.4). */
export function lifecycle(stream: readonly Fact[], F: string, opts: FoldOpts = {}): Lifecycle {
  return ownership(stream, F, opts);
}

/** The author currently holding F's exclusive claim, or null (§3.4). */
export function claimWinner(stream: readonly Fact[], F: string, opts: FoldOpts = {}): string | null {
  const o = ownership(stream, F, opts);
  return o.state === "claimed" || o.state === "resolved" ? o.owner : null;
}

/** Did `author` win the exclusive claim on F? (read-back confirmation, §3.4) */
export function didIWin(stream: readonly Fact[], F: string, author: string, opts: FoldOpts = {}): boolean {
  return claimWinner(stream, F, opts) === author;
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
