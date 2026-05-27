/**
 * v2 identity & integrity (PROTOCOL.md §4).
 *
 * id  = sha256(canonical record), keys sorted, `ts` rendered as a float to
 *       stay byte-compatible with a Python reference. Reuses the v1
 *       stable-stringify so both protocol versions hash identically-shaped data.
 * sig = hmac_sha256(secret, "id|author|type|ts|recv|seq")
 */

import { createHash, createHmac } from "node:crypto";
import { stableJsonStringify } from "./canonical.js";
import { canonicalRecord, type FactInput } from "./types.js";

/** Top-level canonical fields that are floats in the cross-language record. */
const FLOAT_KEYS = new Set(["ts"]);

export function computeId(input: FactInput): string {
  const canonical = stableJsonStringify(canonicalRecord(input), FLOAT_KEYS);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

export function computeSig(
  secret: string,
  parts: { id: string; author: string; type: string; ts: number; recv: number; seq: number },
): string {
  const msg = `${parts.id}|${parts.author}|${parts.type}|${parts.ts}|${parts.recv}|${parts.seq}`;
  return createHmac("sha256", secret).update(msg, "utf-8").digest("hex");
}
