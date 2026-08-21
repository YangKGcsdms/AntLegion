/**
 * AntLegion Protocol v3.0 — core types and append-time validation.
 *
 * One primitive: an immutable, content-addressed Fact at a unique position in a
 * single total order. The bus assigns seq/recv/sig; the author supplies the
 * rest. Everything relational lives in `refs`.
 *
 * §1.1's field domains are enforced here rather than described. v2.0 checked
 * three fields for truthiness, which is why a `ts` of `1e999` became `null` on
 * disk and permanently broke that fact's own content address, and a numeric
 * `type` crashed several folds (§6.1).
 */

/** Reserved fact types the fold layer interprets (§1.4). */
export const RESERVED = {
  CLAIM: "_.claim",
  RESOLVE: "_.resolve",
  RELEASE: "_.release",
  VOTE: "_.vote",
  TOMBSTONE: "_.tombstone",
} as const;

/**
 * Reserved `type` namespaces (§1.4). Facts under these are protocol or
 * operational mechanics, never domain statements — §3.1 excludes them from
 * subject registers so that tagging a `_.tombstone` with `refs.subject` cannot
 * make the retraction itself the register's current value.
 */
export const RESERVED_NAMESPACES = ["_.", "sys.", "context."] as const;

export function isReservedType(type: string): boolean {
  return RESERVED_NAMESPACES.some((p) => type.startsWith(p));
}

/**
 * The lifecycle refs (§1.2). A fact MUST NOT carry more than one; the bus
 * rejects one that does. This removes the only case in which §3.4's fold order
 * would be ambiguous.
 */
export const LIFECYCLE_REFS = ["claim_of", "resolves", "release_of", "tombstones"] as const;

/** The only relational mechanism. Keys are interpreted by readers, not the bus. */
export interface Refs {
  parent?: string;      // causal predecessor
  claim_of?: string;    // author asserts responsibility for the target
  resolves?: string;    // target handled (only from the current claim winner)
  release_of?: string;  // abandon a prior claim
  vote?: string;        // corroborate/contradict target (with payload.verdict)
  supersedes?: string;  // target REPLACED by this fact (target's author only)
  subject?: string;     // world name: the register this fact is a statement about
  tombstones?: string;  // target RETRACTED (target's author only; not supersession)
  about?: string;       // context.requested: the fact found too thin to act on
  answers?: string;     // context.provided: the request it answers
  [k: string]: string | undefined; // unknown keys accepted, not interpreted
}

/** What an author submits to append. */
export interface FactInput {
  type: string;
  author: string;
  ts: number;                       // author-stated unix seconds (advisory)
  payload?: Record<string, unknown>;
  refs?: Refs;
  nonce?: string;                   // uniqueness token to force a distinct id
  id?: string;                      // optional; if present the bus verifies it
}

/** A stored fact. seq/recv/id/sig are bus-assigned. */
export interface Fact {
  seq: number;          // bus-assigned total-order position (trusted)
  recv: number;         // bus-assigned trusted receive time (unix seconds)
  id: string;           // content address = sha256(JCS(record)) (§4.1)
  type: string;
  author: string;
  ts: number;           // author-stated (advisory, spoofable)
  payload: Record<string, unknown>;
  refs: Refs;
  nonce?: string;
  sig: string;          // hmac over id|author|type|ts|recv|seq
  /** Bus-written: this fact's payload was dropped by compaction (§7.2), so it
   *  no longer hashes to its own `id`. A reader MUST NOT report that as an
   *  integrity failure. */
  compacted?: boolean;
}

export interface AppendResult {
  seq: number;
  recv: number;
  id: string;
  sig: string;
  deduped: boolean;     // true if an identical id already existed (idempotent)
}

/** §8 limits. Operator-configurable; these are the protocol defaults. */
export interface Limits {
  maxPayloadBytes: number;
  maxRefsKeys: number;
  maxStringBytes: number;   // type, author, subject
  maxNonceBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxPayloadBytes: 1024 * 1024,
  maxRefsKeys: 64,
  maxStringBytes: 256,
  maxNonceBytes: 128,
};

/**
 * A rejected append, carrying the status §2.1 requires: `400` for a
 * well-formedness violation, `413` for a §8 limit, `409` for a conflict.
 */
export class FactRejected extends Error {
  constructor(message: string, readonly status: 400 | 409 | 413 = 400) {
    super(message);
    this.name = "FactRejected";
  }
}

const TYPE_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf-8");

/**
 * Enforce §1.1's presence/type/domain rules and §1.2's lifecycle-ref
 * exclusivity. Throws `FactRejected`; returns nothing on success.
 *
 * This runs *before* hashing, which is the point: §4.1 can then say the record
 * is the submitted fields with no normalization step. v2.0 silently dropped
 * empty `refs` values while hashing, and two implementations had no way to
 * agree on what that meant.
 */
export function validateFactInput(input: FactInput, limits: Limits = DEFAULT_LIMITS): void {
  const reject = (m: string, status: 400 | 413 = 400): never => {
    throw new FactRejected(m, status);
  };

  // ── type ──
  if (typeof input.type !== "string" || input.type.length === 0) {
    reject("type: required, non-empty string");
  }
  if (utf8Bytes(input.type) > limits.maxStringBytes) {
    reject(`type: exceeds ${limits.maxStringBytes} bytes`, 413);
  }
  if (!TYPE_RE.test(input.type)) {
    reject("type: must be dotted segments of [A-Za-z0-9_-]");
  }

  // ── author ──
  if (typeof input.author !== "string" || input.author.length === 0) {
    reject("author: required, non-empty string");
  }
  if (utf8Bytes(input.author) > limits.maxStringBytes) {
    reject(`author: exceeds ${limits.maxStringBytes} bytes`, 413);
  }

  // ── ts ── finite only: a non-finite double is not JCS-representable (§4.1),
  // so accepting one would mint a fact whose own id cannot be recomputed.
  if (typeof input.ts !== "number" || !Number.isFinite(input.ts)) {
    reject("ts: required, finite number (NaN and Infinity are rejected)");
  }

  // ── payload ──
  const payload = input.payload ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    reject("payload: must be a JSON object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return reject("payload: not JSON-serializable");
  }
  if (serialized === undefined) reject("payload: not JSON-serializable");
  if (utf8Bytes(serialized) > limits.maxPayloadBytes) {
    reject(`payload: exceeds ${limits.maxPayloadBytes} bytes`, 413);
  }

  // ── refs ──
  const refs = input.refs ?? {};
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) {
    reject("refs: must be a JSON object");
  }
  const refKeys = Object.keys(refs);
  if (refKeys.length > limits.maxRefsKeys) {
    reject(`refs: exceeds ${limits.maxRefsKeys} keys`, 413);
  }
  for (const key of refKeys) {
    const value = (refs as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.length === 0) {
      // Rejected, not dropped. Dropping is what v2.0 did, and it made the
      // content address depend on a normalization rule nobody wrote down.
      reject(`refs.${key}: must be a non-empty string (null and "" are rejected)`);
    }
  }
  if (typeof refs.subject === "string" && utf8Bytes(refs.subject) > limits.maxStringBytes) {
    reject(`refs.subject: exceeds ${limits.maxStringBytes} bytes`, 413);
  }

  // ── one lifecycle ref at most (§1.2) ──
  const carried = LIFECYCLE_REFS.filter((k) => typeof refs[k] === "string");
  if (carried.length > 1) {
    reject(`refs: at most one lifecycle ref per fact, got ${carried.join(", ")}`);
  }

  // ── nonce ──
  if (input.nonce !== undefined) {
    if (typeof input.nonce !== "string" || input.nonce.length === 0) {
      reject('nonce: must be a non-empty string ("" is rejected)');
    }
    if (utf8Bytes(input.nonce) > limits.maxNonceBytes) {
      reject(`nonce: exceeds ${limits.maxNonceBytes} bytes`, 413);
    }
  }
}

/**
 * Build the canonical content record for hashing (§4.1): bus-assigned fields
 * excluded, `refs` present only when non-empty, `nonce` only when present.
 *
 * There is no normalization step — `validateFactInput` has already rejected
 * everything that would need normalizing.
 */
export function canonicalRecord(input: FactInput): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    type: input.type,
    author: input.author,
    ts: input.ts,
    payload: input.payload ?? {},
  };
  const refs = input.refs ?? {};
  if (Object.keys(refs).length > 0) rec.refs = { ...refs };
  if (input.nonce !== undefined) rec.nonce = input.nonce;
  return rec;
}
