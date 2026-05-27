/**
 * Conformance: the committed conformance/vectors.json IS the interop contract
 * (PROTOCOL.md §4). This suite asserts the reference implementation reproduces
 * every vector — both the §4 hashes and the §3 normative folds — byte-for-byte.
 * A second-language implementation runs the equivalent of this file against the
 * same JSON to prove interop; here it doubles as a regression guard (a changed
 * hash = a wire-breaking change and turns this suite red).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeId } from "../src/hash.js";
import { canonicalRecord, type Fact, type FactInput } from "../src/types.js";
import { stableJsonStringify } from "../src/canonical.js";
import { lifecycle, trust, supersededBy, causationChain } from "../src/fold.js";

const vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../conformance/vectors.json"), "utf-8"),
);
const TS_FLOAT = new Set(["ts"]);

describe("conformance §4 — identity & canonicalization", () => {
  for (const v of vectors.hash as Array<{ name: string; input: FactInput; canonical: string; id: string }>) {
    it(`hash: ${v.name}`, () => {
      expect(stableJsonStringify(canonicalRecord(v.input), TS_FLOAT)).toBe(v.canonical);
      expect(computeId(v.input)).toBe(v.id);
    });
  }
});

describe("conformance — committed streams are self-consistent (id == hash of content)", () => {
  const all = [
    ...vectors.folds.lifecycle, ...vectors.folds.trust,
    ...vectors.folds.supersession, ...vectors.folds.causation,
  ] as Array<{ name: string; stream: Fact[] }>;
  for (const v of all) {
    it(`stream ids: ${v.name}`, () => {
      for (const f of v.stream) {
        const recomputed = computeId({ type: f.type, author: f.author, ts: f.ts, payload: f.payload, refs: f.refs, nonce: f.nonce });
        expect(recomputed).toBe(f.id);
      }
    });
  }
});

describe("conformance §3.1 — lifecycle fold", () => {
  for (const v of vectors.folds.lifecycle as Array<{ name: string; stream: Fact[]; target: string; opts: any; expect: any }>) {
    it(`lifecycle: ${v.name}`, () => {
      expect(lifecycle(v.stream, v.target, v.opts)).toEqual(v.expect);
    });
  }
});

describe("conformance §3.2 — trust fold", () => {
  for (const v of vectors.folds.trust as Array<{ name: string; stream: Fact[]; target: string; quorum: number; expect: string }>) {
    it(`trust: ${v.name}`, () => {
      expect(trust(v.stream, v.target, v.quorum)).toBe(v.expect);
    });
  }
});

describe("conformance §3.3 — supersession fold", () => {
  for (const v of vectors.folds.supersession as Array<{ name: string; stream: Fact[]; target: string; expect: string | null }>) {
    it(`supersession: ${v.name}`, () => {
      expect(supersededBy(v.stream, v.target)).toBe(v.expect);
    });
  }
});

describe("conformance §3.4 — causation fold", () => {
  for (const v of vectors.folds.causation as Array<{ name: string; stream: Fact[]; target: string; expect: string[] }>) {
    it(`causation: ${v.name}`, () => {
      expect(causationChain(v.stream, v.target).map((f) => f.id)).toEqual(v.expect);
    });
  }
});
