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

/** Build the canonical content record for hashing (§4): bus-assigned fields excluded. */
export function canonicalRecord(input: FactInput): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    type: input.type,
    author: input.author,
    ts: input.ts,
    payload: input.payload ?? {},
  };
  const refs = input.refs ?? {};
  const refEntries = Object.entries(refs).filter(([, v]) => v != null && v !== "");
  if (refEntries.length > 0) {
    rec.refs = Object.fromEntries(refEntries);
  }
  if (input.nonce) rec.nonce = input.nonce;
  return rec;
}
