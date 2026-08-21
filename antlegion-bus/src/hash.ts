/**
 * Identity & integrity (PROTOCOL.md §4).
 *
 * id  = sha256(JCS(record))  — RFC 8785 canonical JSON over the author-supplied
 *       fields only; seq/recv/sig/id are bus-assigned and excluded (§4.1).
 * sig = hmac_sha256(secret, "id|author|type|ts|recv|seq"), with ts/recv rendered
 *       per JCS number formatting and seq as a decimal integer (§4.2).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { jcsStringify } from "./canonical.js";
import { canonicalRecord, type Fact, type FactInput } from "./types.js";

export function computeId(input: FactInput): string {
  const canonical = jcsStringify(canonicalRecord(input));
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * A number rendered the way JCS renders it (§4.2). For every finite double this
 * is ECMAScript `Number::toString` — the shortest representation that round
 * trips — which is exactly what `JSON.stringify` emits for a bare number.
 */
function jcsNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`JCS: non-finite number (${n}) is not representable`);
  }
  return JSON.stringify(n);
}

export function computeSig(
  secret: string,
  parts: { id: string; author: string; type: string; ts: number; recv: number; seq: number },
): string {
  const msg = [
    parts.id,
    parts.author,
    parts.type,
    jcsNumber(parts.ts),
    jcsNumber(parts.recv),
    String(parts.seq),
  ].join("|");
  return createHmac("sha256", secret).update(msg, "utf-8").digest("hex");
}

/**
 * Verify a stored fact's bus signature (§4.2). The HMAC is symmetric, so only a
 * holder of the bus secret can verify — the bus itself (on recovery) or a
 * read-replica that shares the secret, never an unauthenticated HTTP client.
 * Constant-time compare to avoid leaking the signature byte-by-byte.
 *
 * Note the limit stated in §4.2: `sig` covers the header, not `payload`/`refs`.
 * Those are covered by `id`, which recovery re-verifies separately (§7.1).
 */
export function verifySig(secret: string, fact: Fact): boolean {
  const expected = computeSig(secret, {
    id: fact.id, author: fact.author, type: fact.type, ts: fact.ts, recv: fact.recv, seq: fact.seq,
  });
  if (typeof fact.sig !== "string" || fact.sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(fact.sig));
}
