/**
 * Conformance: the committed conformance/vectors.json IS the interop contract
 * (PROTOCOL.md §9.1). This suite asserts the reference implementation reproduces
 * every vector — both the §4 canonical strings/ids and the §3 normative folds —
 * byte-for-byte. A second-language implementation runs the equivalent of this
 * file against the same JSON to prove interop (see conformance/verify.py); here
 * it doubles as a regression guard: a changed vector is a wire-breaking change
 * and turns this suite red.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeId } from "../src/hash.js";
import { canonicalRecord, type Fact, type FactInput } from "../src/types.js";
import { jcsStringify } from "../src/canonical.js";
import {
  lifecycle, claimWinner, trust, supersededBy, isSuperseded, current, history,
  causationChain, descendants, isGap,
} from "../src/fold.js";

const vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../conformance/vectors.json"), "utf-8"),
);

it("the committed vector set is the version this implementation speaks", () => {
  expect(vectors.version).toBe("3.0");
});

describe("conformance §4 — identity & canonicalization (RFC 8785 JCS)", () => {
  for (const v of vectors.hash as Array<{ name: string; input: FactInput; canonical: string; id: string }>) {
    it(`hash: ${v.name}`, () => {
      expect(jcsStringify(canonicalRecord(v.input))).toBe(v.canonical);
      expect(computeId(v.input)).toBe(v.id);
    });
  }
});

describe("conformance — committed streams are self-consistent (id == hash of content)", () => {
  const all = Object.values(vectors.folds).flat() as Array<{ name: string; stream: Fact[] }>;
  for (const v of all) {
    it(`stream ids: ${v.name}`, () => {
      for (const f of v.stream) {
        const recomputed = computeId({ type: f.type, author: f.author, ts: f.ts, payload: f.payload, refs: f.refs, nonce: f.nonce });
        expect(recomputed).toBe(f.id);
      }
    });
  }
});

describe("conformance §3.4 — ownership", () => {
  type V = { name: string; stream: Fact[]; target: string; opts: { now: number; claimTimeout: number }; expect: unknown; claimWinner: string | null };
  for (const v of vectors.folds.lifecycle as V[]) {
    it(`lifecycle: ${v.name}`, () => {
      expect(lifecycle(v.stream, v.target, v.opts)).toEqual(v.expect);
      expect(claimWinner(v.stream, v.target, v.opts)).toBe(v.claimWinner);
    });
  }
});

describe("conformance §3.3 — trust", () => {
  type V = { name: string; stream: Fact[]; target: string; quorum: number; expect: string };
  for (const v of vectors.folds.trust as V[]) {
    it(`trust: ${v.name}`, () => {
      expect(trust(v.stream, v.target, v.quorum)).toBe(v.expect);
    });
  }
});

describe("conformance §3.1 — the subject register", () => {
  type V = {
    name: string; stream: Fact[]; subject: string; target: string;
    history: string[]; current: string | null; supersededBy: string | null; isSuperseded: boolean;
  };
  for (const v of vectors.folds.register as V[]) {
    it(`register: ${v.name}`, () => {
      expect(history(v.stream, v.subject).map((f) => f.id)).toEqual(v.history);
      expect(current(v.stream, v.subject)?.id ?? null).toBe(v.current);
      expect(supersededBy(v.stream, v.target)).toBe(v.supersededBy);
      expect(isSuperseded(v.stream, v.target)).toBe(v.isSuperseded);
    });
  }
});

describe("conformance §3.2 — the trail", () => {
  type V = { name: string; stream: Fact[]; target: string; chain: Array<string | { gap: true; missing: string }>; descendants: string[] };
  for (const v of vectors.folds.trail as V[]) {
    it(`trail: ${v.name}`, () => {
      const walked = causationChain(v.stream, v.target)
        .map((n) => (isGap(n) ? { gap: true as const, missing: n.missing } : n.id));
      expect(walked).toEqual(v.chain);
      expect(descendants(v.stream, v.target).map((f) => f.id)).toEqual(v.descendants);
    });
  }
});
