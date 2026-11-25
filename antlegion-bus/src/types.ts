/**
 * AntLegion Protocol v2 — core types.
 *
 * One primitive: an immutable, content-addressed Fact at a unique position in a
 * single total order. See PROTOCOL.md (v2). The bus assigns seq/recv/sig; the
 * author supplies the rest. Everything relational lives in `refs`.
 */

/** Reserved fact types the fold layer interprets (§3, §9). */
export const RESERVED = {
  CLAIM: "_.claim",
  RESOLVE: "_.resolve",
  RELEASE: "_.release",
  VOTE: "_.vote",
  TOMBSTONE: "_.tombstone",
} as const;

/** The only relational mechanism. Keys are interpreted by readers, not the bus. */
export interface Refs {
  parent?: string;      // causal predecessor
  claim_of?: string;    // exclusive claim on target
  resolves?: string;    // target handled
  release_of?: string;  // abandon a prior claim
  vote?: string;        // corroborate/contradict target (with payload.verdict)
  supersedes?: string;  // target REPLACED by a successor (this fact)
  subject?: string;     // group key for latest-wins supersession
  tombstones?: string;  // target DELETED / GC'd (distinct from supersedes)
  about?: string;       // context.requested: the fact found insufficient (§3.6)
  answers?: string;     // context.provided: the context.requested it answers (§3.6)
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
  id?: string;                      // optional; "" or absent → bus computes
}

/** A stored fact. seq/recv/id/sig are bus-assigned. */
export interface Fact {
  seq: number;          // bus-assigned total-order position (trusted)
  recv: number;         // bus-assigned trusted receive time (unix seconds)
  id: string;           // content address = hash(canonical) (§4)
  type: string;
  author: string;
  ts: number;           // author-stated (advisory, spoofable)
  payload: Record<string, unknown>;
  refs: Refs;
  nonce?: string;
  sig: string;          // hmac over id|author|type|ts|recv|seq
}

export interface AppendResult {
  seq: number;
  recv: number;
  id: string;
  sig: string;
  deduped: boolean;     // true if an identical id already existed (idempotent)
}

/** Invalid submitted content, distinct from a hash conflict or an I/O failure. */
export class FactInputError extends TypeError {}

function plainObject(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new FactInputError(`${at} must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Snapshot ordinary JSON fields before hashing and storing them. */
function jsonSnapshot(value: unknown, at: string, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== "object" || value === null) {
    throw new FactInputError(`${at} must contain only JSON values and finite numbers`);
  }
  if (ancestors.has(value)) throw new FactInputError(`${at} must not contain a circular reference`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item, index) => jsonSnapshot(item, `${at}[${index}]`, ancestors));
    }
    // fromEntries preserves an own __proto__ key instead of changing a prototype.
    return Object.fromEntries(Object.entries(plainObject(value, at)).map(
      ([key, item]) => [key, jsonSnapshot(item, `${at}.${key}`, ancestors)],
    ));
  } finally {
    ancestors.delete(value);
  }
}

export interface NormalizedFactInput extends FactInput {
  payload: Record<string, unknown>;
  refs: Refs;
}

/** Shared Node input contract for hashing, local append and HTTP transport. */
export function normalizeFactInput(input: FactInput): NormalizedFactInput {
  const { type, author, ts, payload, refs, nonce, id } = plainObject(input, "fact");
  if (typeof type !== "string" || !type || typeof author !== "string" || !author ||
      typeof ts !== "number" || !Number.isFinite(ts)) {
    throw new FactInputError("type, author, ts are required (ts must be finite)");
  }
  if (nonce !== undefined && typeof nonce !== "string") throw new FactInputError("nonce must be a string");
  if (id !== undefined && typeof id !== "string") throw new FactInputError("id must be a string");
  const refEntries: [string, string][] = [];
  if (refs !== undefined) {
    for (const [key, value] of Object.entries(plainObject(refs, "refs"))) {
      if (value === undefined || value === "") continue;
      if (typeof value !== "string") throw new FactInputError("refs must map keys to strings");
      refEntries.push([key, value]);
    }
  }
  return {
    type, author, ts: Object.is(ts, -0) ? 0 : ts,
    payload: payload === undefined ? {} : jsonSnapshot(plainObject(payload, "payload"), "payload") as Record<string, unknown>,
    refs: Object.fromEntries(refEntries),
    ...(nonce ? { nonce: nonce as string } : {}),
    ...(id ? { id: id as string } : {}),
  };
}

/** Build the canonical content record for hashing (§4): bus-assigned fields excluded. */
export function canonicalRecord(input: FactInput): Record<string, unknown> {
  const normalized = normalizeFactInput(input);
  const rec: Record<string, unknown> = {
    type: normalized.type,
    author: normalized.author,
    ts: normalized.ts,
    payload: normalized.payload,
  };
  if (Object.keys(normalized.refs).length > 0) rec.refs = normalized.refs;
  if (normalized.nonce) rec.nonce = normalized.nonce;
  return rec;
}
