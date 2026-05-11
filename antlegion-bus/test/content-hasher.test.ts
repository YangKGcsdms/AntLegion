import { describe, it, expect } from "vitest";
import {
  computeContentHash,
  verifyContentHash,
  canonicalImmutableRecord,
  stableJsonStringify,
} from "../src/engine/ContentHasher.js";
import { createFact, Priority } from "../src/types/protocol.js";

describe("ContentHasher", () => {
  // Spec-conformant test vectors per PROTOCOL.md §10.1 — canonical immutable
  // record, sort_keys=True, ensure_ascii=False, sha256 of the resulting JSON.
  //
  // Each vector below has been verified to produce the same digest in Python:
  //
  //   def canonical(fact):
  //       record = { 'fact_type': ..., 'payload': ..., 'source_ant_id': ...,
  //                  'created_at': ..., 'mode': ..., 'priority': ...,
  //                  'ttl_seconds': ..., 'causation_depth': ... }
  //       # Optional fields included only when present (non-empty / non-null).
  //       if pid: record['parent_fact_id'] = pid
  //       if fact.confidence is not None: record['confidence'] = fact.confidence
  //       if fact.domain_tags: record['domain_tags'] = sorted(fact.domain_tags)
  //       if fact.need_capabilities: record['need_capabilities'] = sorted(...)
  //       return record
  //
  //   hashlib.sha256(json.dumps(canonical(fact), sort_keys=True,
  //                             ensure_ascii=False).encode()).hexdigest()
  //
  // If you change the canonical record format, update these vectors and the
  // matching reference in PROTOCOL.md §10.1 in the same commit.
  const VECTOR_1 = {
    fact: createFact({
      fact_type: "test",
      payload: { key: "value", nested: { a: 1 } },
      source_ant_id: "src",
      created_at: 1000.0,
      ttl_seconds: 300,
      causation_depth: 0,
      mode: "exclusive",
      priority: Priority.NORMAL,
    }),
    expectedHash:
      "33dc6c76a43bdd85073c6591f858f6fa2702474930954845378fc3ec8620ba21",
  };

  const VECTOR_2 = {
    fact: createFact({
      fact_type: "code.review",
      payload: { file: "auth.py" },
      source_ant_id: "ant-001",
      created_at: 2000.0,
      ttl_seconds: 600,
      causation_depth: 0,
      mode: "broadcast",
      priority: Priority.HIGH,
      domain_tags: ["python", "auth"],
      need_capabilities: ["review"],
      confidence: 0.9,
    }),
    expectedHash:
      "c5c909b45716af4f9909bd81e5e4c00101441ea478024a1e66cab45d3c411800",
  };

  const VECTOR_3 = {
    fact: createFact({
      fact_type: "child",
      payload: { data: 1 },
      source_ant_id: "ant-b",
      created_at: 3000.0,
      ttl_seconds: 300,
      causation_depth: 2,
      causation_chain: ["grandparent", "parent-001"],
      mode: "exclusive",
      priority: Priority.NORMAL,
    }),
    expectedHash:
      "8d9682806eb8ec7d6db23914a5bda0275f5018b0d5dd38369033e8fbc27b04e2",
  };

  it("matches canonical record hash (vector 1: simple fact)", () => {
    const hash = computeContentHash(VECTOR_1.fact);
    expect(hash).toBe(VECTOR_1.expectedHash);
  });

  it("matches canonical record hash (vector 2: with tags, capabilities, confidence)", () => {
    const hash = computeContentHash(VECTOR_2.fact);
    expect(hash).toBe(VECTOR_2.expectedHash);
  });

  it("matches canonical record hash (vector 3: with causation_chain)", () => {
    const hash = computeContentHash(VECTOR_3.fact);
    expect(hash).toBe(VECTOR_3.expectedHash);
  });

  it("produces 64-char hex digest", () => {
    const hash = computeContentHash(VECTOR_1.fact);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("same content → same hash (deterministic)", () => {
    const h1 = computeContentHash(VECTOR_1.fact);
    const h2 = computeContentHash(VECTOR_1.fact);
    expect(h1).toBe(h2);
  });

  it("different fact_type → different hash", () => {
    const other = createFact({ ...VECTOR_1.fact, fact_type: "other" });
    expect(computeContentHash(other)).not.toBe(VECTOR_1.expectedHash);
  });

  it("verifyContentHash passes for correct hash", () => {
    const fact = { ...VECTOR_1.fact, content_hash: VECTOR_1.expectedHash };
    expect(verifyContentHash(fact)).toBe(true);
  });

  it("verifyContentHash fails for wrong hash", () => {
    const fact = { ...VECTOR_1.fact, content_hash: "0".repeat(64) };
    expect(verifyContentHash(fact)).toBe(false);
  });

  it("verifyContentHash passes for empty hash", () => {
    const fact = { ...VECTOR_1.fact, content_hash: "" };
    expect(verifyContentHash(fact)).toBe(true);
  });
});

describe("stableJsonStringify", () => {
  it("sorts keys at all nesting levels", () => {
    const obj = { z: 1, a: { c: 3, b: 2 } };
    const result = stableJsonStringify(obj);
    // Matches Python json.dumps(sort_keys=True) format: space after colon/comma
    expect(result).toBe('{"a": {"b": 2, "c": 3}, "z": 1}');
  });

  it("handles arrays (preserves order)", () => {
    const obj = { arr: [3, 1, 2] };
    expect(stableJsonStringify(obj)).toBe('{"arr": [3, 1, 2]}');
  });

  it("handles null", () => {
    const obj = { a: null };
    expect(stableJsonStringify(obj)).toBe('{"a": null}');
  });
});
