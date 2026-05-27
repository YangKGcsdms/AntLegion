/**
 * Conformance-vector generator (PROTOCOL.md §4).
 *
 * Derives the canonical cross-language interop contract from THIS reference
 * implementation and writes it to `vectors.json`. The committed file is the
 * frozen contract: `test/conformance.test.ts` reads it back and asserts the
 * impl still reproduces every value (a regression guard), and a second-language
 * implementation (Python, Go, …) MUST reproduce the same `canonical`/`id`
 * strings and the same fold outputs byte-for-byte.
 *
 *   npx tsx conformance/generate.ts      # regenerate vectors.json
 *
 * Regenerate ONLY on an intentional protocol change, and review the diff: a
 * changed hash is a wire-breaking change.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeId, computeSig } from "../src/hash.js";
import { canonicalRecord, type Fact, type FactInput } from "../src/types.js";
import { stableJsonStringify } from "../src/canonical.js";
import { lifecycle, trust, supersededBy, causationChain } from "../src/fold.js";

const SECRET = "conformance-secret";
const TS_FLOAT = new Set(["ts"]);

// ── hash vectors: input record → canonical string + content-address id ──────
const hashInputs: Array<{ name: string; input: FactInput }> = [
  { name: "minimal", input: { type: "build.failed", author: "claude-code", ts: 1748300000.0, payload: {} } },
  { name: "with-refs", input: { type: "_.claim", author: "alice", ts: 1748300001.5, payload: {}, refs: { claim_of: "abc123" } } },
  { name: "with-nonce", input: { type: "_.claim", author: "bob", ts: 1, payload: {}, refs: { claim_of: "abc123" }, nonce: "k7x9" } },
  { name: "nested-payload-key-sort", input: { type: "t", author: "u", ts: 2.0, payload: { z: 1, a: { d: 4, b: 2 }, m: [3, 1, 2] } } },
  { name: "whole-number-ts-renders-float", input: { type: "t", author: "u", ts: 100, payload: {} } },
  { name: "unicode-payload", input: { type: "事实", author: "张三", ts: 3.0, payload: { msg: "你好, world ✅" } } },
  { name: "empty-refs-omitted-from-canonical", input: { type: "t", author: "u", ts: 4.0, payload: {}, refs: {} } },
];
const hash = hashInputs.map(({ name, input }) => ({
  name,
  input,
  canonical: stableJsonStringify(canonicalRecord(input), TS_FLOAT),
  id: computeId(input),
}));

// ── fold vectors: a fact stream + target → expected fold output ─────────────
type C = { type: string; author: string; ts: number; payload?: Record<string, unknown>; refs?: Record<string, string>; nonce?: string };
function mk(seq: number, recv: number, c: C): Fact {
  const input: FactInput = { type: c.type, author: c.author, ts: c.ts, payload: c.payload, refs: c.refs, nonce: c.nonce };
  const id = computeId(input);
  const sig = computeSig(SECRET, { id, author: c.author, type: c.type, ts: c.ts, recv, seq });
  return { seq, recv, id, type: c.type, author: c.author, ts: c.ts, payload: c.payload ?? {}, refs: c.refs ?? {}, ...(c.nonce ? { nonce: c.nonce } : {}), sig };
}
function scn() {
  let seq = 0;
  const facts: Fact[] = [];
  const add = (recv: number, c: C) => { const f = mk(++seq, recv, c); facts.push(f); return f; };
  return { facts, add };
}

const DELTA = 600;
const lifecycleVecs: unknown[] = [];
const Lc = (name: string, facts: Fact[], F: string, opts: { now?: number; claimTimeout?: number }) =>
  lifecycleVecs.push({ name, stream: facts, target: F, opts, expect: lifecycle(facts, F, opts) });

{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  Lc("open", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  Lc("claimed", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.claim", author: "bob", ts: 3, refs: { claim_of: F.id }, nonce: "b" });
  Lc("exactly-once-lowest-seq-wins", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.resolve", author: "alice", ts: 3, refs: { resolves: F.id }, nonce: "r" });
  Lc("resolved-by-winner-terminal", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.resolve", author: "mallory", ts: 3, refs: { resolves: F.id }, nonce: "r" });
  Lc("resolve-by-non-winner-ignored", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "announce", author: "seed", ts: 1 });
  s.add(101, { type: "_.resolve", author: "anyone", ts: 2, refs: { resolves: F.id }, nonce: "r" }); // never claimed → any author resolves
  Lc("broadcast-resolve-never-claimed", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.release", author: "alice", ts: 3, refs: { release_of: F.id }, nonce: "x" });
  Lc("released-back-to-open", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.tombstone", author: "gc", ts: 2, refs: { tombstones: F.id }, nonce: "t" });
  Lc("dead-via-tombstone", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(1000, { type: "task", author: "seed", ts: 1 });
  s.add(1001, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" }); // recv 1001
  s.add(2000, { type: "_.claim", author: "bob", ts: 3, refs: { claim_of: F.id }, nonce: "b" });   // alice expired (1001+600<2000)
  Lc("timeout-redispatch-recv-anchored", s.facts, F.id, { now: 2050, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(1000, { type: "task", author: "seed", ts: 1 });
  s.add(1001, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(1100, { type: "_.resolve", author: "alice", ts: 3, refs: { resolves: F.id }, nonce: "r" }); // before expiry → terminal
  s.add(9000, { type: "_.claim", author: "bob", ts: 4, refs: { claim_of: F.id }, nonce: "b" });
  Lc("resolve-before-expiry-stays-terminal", s.facts, F.id, { now: 9999, claimTimeout: DELTA }); }

const trustVecs: unknown[] = [];
const Tr = (name: string, facts: Fact[], F: string, quorum: number) =>
  trustVecs.push({ name, stream: facts, target: F, quorum, expect: trust(facts, F, quorum) });

{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  Tr("asserted-no-votes", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  Tr("corroborated-one-vote", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "carol", ts: 3, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "2" });
  Tr("consensus-quorum-2", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "carol", ts: 3, payload: { verdict: "contradict" }, refs: { vote: F.id }, nonce: "2" });
  Tr("contested-one-contradict", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "contradict" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "carol", ts: 3, payload: { verdict: "contradict" }, refs: { vote: F.id }, nonce: "2" });
  Tr("refuted-quorum-2", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "alice", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  Tr("self-vote-ignored", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "bob", ts: 3, payload: { verdict: "contradict" }, refs: { vote: F.id }, nonce: "2" });
  Tr("latest-vote-wins-per-author", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "obs", author: "carol", ts: 3, refs: { supersedes: F.id }, nonce: "s" });
  Tr("superseded-beats-trust", s.facts, F.id, 2); }

const supersedeVecs: unknown[] = [];
const Sp = (name: string, facts: Fact[], F: string) =>
  supersedeVecs.push({ name, stream: facts, target: F, expect: supersededBy(facts, F) });

{ const s = scn(); const F = s.add(1, { type: "obs", author: "a", ts: 1 });
  Sp("not-superseded", s.facts, F.id); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "a", ts: 1 });
  s.add(2, { type: "obs", author: "b", ts: 2, refs: { supersedes: F.id }, nonce: "g" });
  Sp("explicit-supersedes", s.facts, F.id); }
{ const s = scn(); const F = s.add(1, { type: "status", author: "a", ts: 1, refs: { subject: "deploy" } });
  s.add(2, { type: "status", author: "b", ts: 2, refs: { subject: "deploy" } });
  Sp("subject-latest-wins", s.facts, F.id); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "a", ts: 1 });
  s.add(2, { type: "_.tombstone", author: "gc", ts: 2, refs: { tombstones: F.id }, nonce: "t" });
  Sp("tombstone-is-not-supersession", s.facts, F.id); }

const causationVecs: unknown[] = [];
const Ca = (name: string, facts: Fact[], F: string) =>
  causationVecs.push({ name, stream: facts, target: F, expect: causationChain(facts, F).map((f) => f.id) });

{ const s = scn(); const A = s.add(1, { type: "root", author: "a", ts: 1 });
  Ca("root-only", s.facts, A.id); }
{ const s = scn(); const A = s.add(1, { type: "build", author: "a", ts: 1 });
  const B = s.add(2, { type: "test", author: "a", ts: 2, refs: { parent: A.id } });
  const Cc = s.add(3, { type: "deploy", author: "a", ts: 3, refs: { parent: B.id } });
  Ca("chain-root-to-fact", s.facts, Cc.id); }

const vectors = {
  version: "2.0",
  description: "AntLegion Protocol v2 conformance vectors. hash[] = canonical/id (§4); folds = normative reader folds (§3). A conforming implementation MUST reproduce every value byte-for-byte.",
  secret: SECRET,
  defaults: { claimTimeout: DELTA, quorum: 2 },
  hash,
  folds: { lifecycle: lifecycleVecs, trust: trustVecs, supersession: supersedeVecs, causation: causationVecs },
};

const out = join(dirname(fileURLToPath(import.meta.url)), "vectors.json");
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n", "utf-8");
console.log(`wrote ${out}: ${hash.length} hash + ${lifecycleVecs.length}+${trustVecs.length}+${supersedeVecs.length}+${causationVecs.length} fold vectors`);
