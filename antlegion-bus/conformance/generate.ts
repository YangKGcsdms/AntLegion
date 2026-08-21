/**
 * Conformance-vector generator (PROTOCOL.md §9.1).
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
 * changed hash is a wire-breaking change. The converse is the useful half of
 * the rule — if you only restated the spec without changing its meaning, this
 * file must not move at all. A moved vector after a "pure rewrite" means the
 * rewrite changed semantics.
 *
 * §9.1 names the coverage this set must carry, and it is organized around one
 * idea: a vector exists for **the cases where two readings diverge**. Hashes
 * alone give no evidence about §3, which is where all the meaning is.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeId, computeSig } from "../src/hash.js";
import { canonicalRecord, validateFactInput, type Fact, type FactInput } from "../src/types.js";
import { jcsStringify } from "../src/canonical.js";
import {
  lifecycle, claimWinner, trust, supersededBy, isSuperseded, current, history,
  causationChain, descendants, isGap,
} from "../src/fold.js";

const SECRET = "conformance-secret";
const DELTA = 600;

// ── §4 hash vectors: input record → JCS canonical string + content address ────
//
// Coverage is not decorative. Each of these is a place two independent
// implementations have actually diverged, or would: key ordering by UTF-16 code
// unit rather than code point, ECMAScript number formatting at the exponent
// boundaries, escaping, and the presence/absence rules for `refs` and `nonce`.
const hashInputs: Array<{ name: string; note: string; input: FactInput }> = [
  { name: "minimal", note: "no refs, no nonce — both omitted from the record",
    input: { type: "build.failed", author: "claude-code", ts: 1748300000.0, payload: {} } },
  { name: "with-refs", note: "refs present ⇒ included",
    input: { type: "_.claim", author: "alice", ts: 1748300001.5, payload: {}, refs: { claim_of: "abc123" } } },
  { name: "with-nonce", note: "nonce present ⇒ included",
    input: { type: "_.claim", author: "bob", ts: 1, payload: {}, refs: { claim_of: "abc123" }, nonce: "k7x9" } },
  { name: "empty-refs-omitted", note: "refs {} ⇒ key absent from the record, same id as `minimal`-shaped input",
    input: { type: "t", author: "u", ts: 4.0, payload: {}, refs: {} } },
  { name: "nested-payload-key-sort", note: "sorting is recursive; arrays keep their order",
    input: { type: "t", author: "u", ts: 2.0, payload: { z: 1, a: { d: 4, b: 2 }, m: [3, 1, 2] } } },
  { name: "non-bmp-key-sort",
    note: "THE hazard: sorted by UTF-16 code unit, the astral key precedes U+FF3A. " +
          "Python's bare sorted() orders by code point and gets the opposite answer.",
    input: { type: "t", author: "u", ts: 1, payload: { [String.fromCodePoint(0x1f600)]: 1, [String.fromCharCode(0xff3a)]: 2, a: 3, Z: 4 } } },
  { name: "number-exponent-boundaries",
    note: "ECMAScript Number::toString switches notation at these points: 1e-7 and 1e21 render exponential, 1e-6 and 1e16 do not",
    input: { type: "t", author: "u", ts: 1, payload: { a: 1e-7, b: 1e-6, c: 1e16, d: 1e21 } } },
  { name: "integer-beyond-2-53",
    note: "not representable exactly as a double; both languages must emit the SAME rounded value",
    input: { type: "t", author: "u", ts: 1, payload: { n: 9007199254740993 } } },
  { name: "whole-number-ts", note: "JCS renders 100 as 100 — v2.0's trailing `.0` rule is gone",
    input: { type: "t", author: "u", ts: 100, payload: {} } },
  { name: "negative-zero-ts", note: "-0 serializes as 0 (JCS/ECMAScript), so ts:-0 and ts:0 are the same fact",
    input: { type: "t", author: "u", ts: -0, payload: {} } },
  { name: "unicode-payload", note: "non-ASCII passes through unescaped; only JSON's mandatory escapes are applied",
    input: { type: "shi.shi", author: "张三", ts: 3.0, payload: { msg: "你好, world ✅" } } },
  { name: "escapes-required", note: "quote, backslash, and control characters take their short or \\u00XX form",
    input: { type: "t", author: "u", ts: 1, payload: { s: 'a"b\\c' + String.fromCharCode(9) + String.fromCharCode(1) } } },
  { name: "lone-surrogate", note: "an unpaired surrogate is emitted as \\udXXX (well-formed JSON.stringify)",
    input: { type: "t", author: "u", ts: 1, payload: { s: String.fromCharCode(0xd800) } } },
];
const hash = hashInputs.map(({ name, note, input }) => {
  validateFactInput(input);
  return { name, note, input, canonical: jcsStringify(canonicalRecord(input)), id: computeId(input) };
});

// ── fold vectors: a fact stream + target → expected fold output ──────────────
type C = { type: string; author: string; ts: number; payload?: Record<string, unknown>; refs?: Record<string, string>; nonce?: string };
function mk(seq: number, recv: number, c: C): Fact {
  const input: FactInput = { type: c.type, author: c.author, ts: c.ts, payload: c.payload, refs: c.refs, nonce: c.nonce };
  validateFactInput(input);
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

// ── §3.4 ownership / lifecycle ───────────────────────────────────────────────
const lifecycleVecs: unknown[] = [];
const Lc = (name: string, note: string, facts: Fact[], F: string, opts: { now?: number; claimTimeout?: number }) =>
  lifecycleVecs.push({ name, note, stream: facts, target: F, opts,
    expect: lifecycle(facts, F, opts), claimWinner: claimWinner(facts, F, opts) });

{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  Lc("open", "nothing references F", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  Lc("claimed", "one live claim", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.claim", author: "bob", ts: 3, refs: { claim_of: F.id }, nonce: "b" });
  Lc("exactly-once-lowest-seq-wins", "the theorem: lowest seq, not first-observed", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.resolve", author: "alice", ts: 3, refs: { resolves: F.id }, nonce: "r" });
  Lc("resolved-by-winner-terminal", "the winner resolves; terminal", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.resolve", author: "mallory", ts: 3, refs: { resolves: F.id }, nonce: "r" });
  Lc("resolve-by-non-winner-ignored", "a stranger's resolve is not honoured", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "announce", author: "seed", ts: 1 });
  s.add(101, { type: "_.resolve", author: "anyone", ts: 2, refs: { resolves: F.id }, nonce: "r" });
  Lc("resolve-never-claimed-ignored",
     "v2.0 honoured this and it was a denial primitive: resolved is terminal, so one " +
     "well-formed fact from any writer closed any never-claimed item permanently. " +
     "To resolve, first claim.",
     s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(1000, { type: "task", author: "seed", ts: 1 });
  s.add(1001, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(3000, { type: "_.resolve", author: "mallory", ts: 3, refs: { resolves: F.id }, nonce: "r" });
  Lc("resolve-by-stranger-after-lapse-ignored",
     "alice's claim has expired by recv 3000, so there is no winner — and a lapsed claim means " +
     "the work needs re-dispatch, not closing by a passer-by",
     s.facts, F.id, { now: 3050, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.release", author: "alice", ts: 3, refs: { release_of: F.id }, nonce: "x" });
  Lc("released-back-to-open", "the holder releases", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(102, { type: "_.release", author: "mallory", ts: 3, refs: { release_of: F.id }, nonce: "x" });
  Lc("release-by-non-holder-ignored", "only an author holding a live claim may release it", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.tombstone", author: "seed", ts: 2, refs: { tombstones: F.id }, nonce: "t" });
  Lc("dead-via-own-authors-tombstone", "retraction is taking back YOUR OWN statement", s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(100, { type: "task", author: "seed", ts: 1 });
  s.add(101, { type: "_.tombstone", author: "mallory", ts: 2, refs: { tombstones: F.id }, nonce: "t" });
  Lc("stranger-tombstone-does-not-retract",
     "v2.0 let any author tombstone any fact — terminal state, register to null, and compaction " +
     "then entitled to destroy the payload. A protocol-sanctioned data-destruction primitive.",
     s.facts, F.id, { now: 150, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(1000, { type: "task", author: "seed", ts: 1 });
  s.add(1001, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(1601, { type: "_.claim", author: "bob", ts: 3, refs: { claim_of: F.id }, nonce: "b" });
  Lc("claim-expiry-exactly-at-delta",
     "1001 + 600 == 1601 and expiry is `fact.recv <= claim.recv + Delta`, so alice is still live at the " +
     "boundary and still wins on lowest seq. Evaluated at now == 1601 so the advisory trailing branch " +
     "does not muddy the deterministic one.",
     s.facts, F.id, { now: 1601, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(1000, { type: "task", author: "seed", ts: 1 });
  s.add(1001, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(1602, { type: "_.claim", author: "bob", ts: 3, refs: { claim_of: F.id }, nonce: "b" });
  Lc("claim-expiry-one-past-delta", "one second later alice has lapsed and bob takes it", s.facts, F.id, { now: 1650, claimTimeout: DELTA }); }
{ const s = scn(); const F = s.add(1000, { type: "task", author: "seed", ts: 1 });
  s.add(1001, { type: "_.claim", author: "alice", ts: 2, refs: { claim_of: F.id }, nonce: "a" });
  s.add(1100, { type: "_.resolve", author: "alice", ts: 3, refs: { resolves: F.id }, nonce: "r" });
  s.add(9000, { type: "_.claim", author: "bob", ts: 4, refs: { claim_of: F.id }, nonce: "b" });
  Lc("resolve-before-expiry-stays-terminal", "crash-recovery re-dispatch must not un-do a real resolve", s.facts, F.id, { now: 9999, claimTimeout: DELTA }); }

// ── §3.3 trust ───────────────────────────────────────────────────────────────
const trustVecs: unknown[] = [];
const Tr = (name: string, note: string, facts: Fact[], F: string, quorum: number) =>
  trustVecs.push({ name, note, stream: facts, target: F, quorum, expect: trust(facts, F, quorum) });

{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  Tr("asserted-no-votes", "the floor state", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  Tr("corroborated-one-vote", "below quorum", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  Tr("consensus-quorum-1", "quorum is the READER's policy; MUST be >= 1", s.facts, F.id, 1); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "carol", ts: 3, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "2" });
  Tr("consensus-quorum-2", "two distinct authors", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "carol", ts: 3, payload: { verdict: "contradict" }, refs: { vote: F.id }, nonce: "2" });
  Tr("contested-one-contradict", "any contradiction outranks corroboration below quorum", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "contradict" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "carol", ts: 3, payload: { verdict: "contradict" }, refs: { vote: F.id }, nonce: "2" });
  Tr("refuted-quorum-2", "", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "alice", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  Tr("self-vote-ignored", "you do not corroborate yourself", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "bob", ts: 3, payload: { verdict: "contradict" }, refs: { vote: F.id }, nonce: "2" });
  Tr("latest-vote-wins-per-author", "a voter who changes their mind is counted once", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.vote", author: "bob", ts: 3, payload: { verdict: "maybe" }, refs: { vote: F.id }, nonce: "2" });
  Tr("unrecognized-verdict-excluded",
     "the junk vote does NOT take bob's slot — in v2.0 it silently cancelled his earlier valid one",
     s.facts, F.id, 1); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "obs", author: "alice", ts: 3, refs: { supersedes: F.id }, nonce: "s" });
  Tr("superseded-beats-trust", "freshness outranks confidence", s.facts, F.id, 2); }
{ const s = scn(); const F = s.add(1, { type: "obs", author: "alice", ts: 1 });
  s.add(2, { type: "_.vote", author: "bob", ts: 2, payload: { verdict: "corroborate" }, refs: { vote: F.id }, nonce: "1" });
  s.add(3, { type: "_.tombstone", author: "alice", ts: 3, refs: { tombstones: F.id }, nonce: "t" });
  Tr("retracted-outranks-consensus",
     "v2.0 had no retracted state, so a tombstoned fact could fold to consensus",
     s.facts, F.id, 1); }

// ── §3.1 the subject register ────────────────────────────────────────────────
const registerVecs: unknown[] = [];
const Rg = (name: string, note: string, facts: Fact[], subject: string, target: string) =>
  registerVecs.push({
    name, note, stream: facts, subject, target,
    history: history(facts, subject).map((f) => f.id),
    current: current(facts, subject)?.id ?? null,
    supersededBy: supersededBy(facts, target),
    isSuperseded: isSuperseded(facts, target),
  });

{ const s = scn(); const F = s.add(1, { type: "obs", author: "a", ts: 1 });
  Rg("no-subject-not-superseded", "a fact outside any register", s.facts, "nobody", F.id); }
{ const s = scn();
  const A = s.add(1, { type: "status", author: "a", ts: 1, refs: { subject: "deploy" } });
  s.add(2, { type: "status", author: "b", ts: 2, refs: { subject: "deploy" } });
  s.add(3, { type: "status", author: "c", ts: 3, refs: { subject: "deploy" } });
  s.add(4, { type: "status", author: "d", ts: 4, refs: { subject: "deploy" } });
  Rg("four-member-register-immediate-vs-latest",
     "THE divergence: supersededBy(A) is the NEXT member (seq 2), current(S) is the LATEST (seq 4). " +
     "v2.0 returned the latest for both.",
     s.facts, "deploy", A.id); }
{ const s = scn();
  const A = s.add(1, { type: "obs", author: "a", ts: 1 });
  s.add(2, { type: "obs", author: "a", ts: 2, refs: { supersedes: A.id }, nonce: "x" });
  s.add(3, { type: "obs", author: "a", ts: 3, refs: { supersedes: A.id }, nonce: "y" });
  Rg("two-explicit-successors-lowest-seq-wins",
     "ties break by seq, which is total, so there is never a choice; the other is an ordinary fact",
     s.facts, "none", A.id); }
{ const s = scn();
  const A = s.add(1, { type: "obs", author: "a", ts: 1 });
  s.add(2, { type: "obs", author: "mallory", ts: 2, refs: { supersedes: A.id }, nonce: "x" });
  Rg("unauthorized-supersede-ignored",
     "because superseded outranks every vote in 3.3, an ungated supersedes let any author " +
     "silence any fact's trust state with one append",
     s.facts, "none", A.id); }
{ const s = scn();
  const A = s.add(1, { type: "obs", author: "a", ts: 1 });
  const B = s.add(2, { type: "obs", author: "a", ts: 2, refs: { supersedes: A.id }, nonce: "x" });
  s.add(3, { type: "_.tombstone", author: "a", ts: 3, refs: { tombstones: B.id }, nonce: "t" });
  Rg("retracted-successor-supersedes-nothing",
     "otherwise retracting a bad replacement leaves the original permanently superseded with nothing current",
     s.facts, "none", A.id); }
{ const s = scn();
  const A = s.add(1, { type: "status", author: "a", ts: 1, refs: { subject: "deploy" } });
  const B = s.add(2, { type: "status", author: "a", ts: 2, refs: { subject: "deploy" } });
  s.add(3, { type: "_.tombstone", author: "a", ts: 3, refs: { tombstones: B.id }, nonce: "t" });
  Rg("register-head-retracted-folds-to-null",
     "retraction is not rollback: nothing is currently known, NOT the previous value",
     s.facts, "deploy", A.id); }
{ const s = scn();
  const A = s.add(1, { type: "status", author: "a", ts: 1, refs: { subject: "deploy" } });
  s.add(2, { type: "status", author: "a", ts: 2, refs: { subject: "deploy" } });
  s.add(3, { type: "_.tombstone", author: "a", ts: 3, refs: { tombstones: A.id }, nonce: "t" });
  Rg("non-head-retraction-leaves-current-alone",
     "a tombstone on a non-head member does not move current(S)",
     s.facts, "deploy", A.id); }
{ const s = scn();
  const A = s.add(1, { type: "status", author: "a", ts: 1, refs: { subject: "deploy" } });
  s.add(2, { type: "_.tombstone", author: "a", ts: 2, refs: { tombstones: A.id, subject: "deploy" }, nonce: "t" });
  Rg("reserved-type-is-not-a-register-member",
     "tagging a _.tombstone with refs.subject must not make the retraction itself current(S), " +
     "nor supersede the fact it retracts",
     s.facts, "deploy", A.id); }

// ── §3.2 the trail ───────────────────────────────────────────────────────────
const trailVecs: unknown[] = [];
const Tl = (name: string, note: string, facts: Fact[], F: string) =>
  trailVecs.push({
    name, note, stream: facts, target: F,
    chain: causationChain(facts, F).map((n) => (isGap(n) ? { gap: true, missing: n.missing } : n.id)),
    descendants: descendants(facts, F).map((f) => f.id),
  });

{ const s = scn(); const A = s.add(1, { type: "root", author: "a", ts: 1 });
  Tl("root-only", "a fact with no parent has depth 1", s.facts, A.id); }
{ const s = scn(); const A = s.add(1, { type: "build", author: "a", ts: 1 });
  const B = s.add(2, { type: "test", author: "a", ts: 2, refs: { parent: A.id } });
  const Cc = s.add(3, { type: "deploy", author: "a", ts: 3, refs: { parent: B.id } });
  Tl("chain-root-to-fact", "root -> F", s.facts, Cc.id); }
{ const s = scn();
  const B = s.add(1, { type: "test", author: "a", ts: 1, refs: { parent: "0".repeat(64) } });
  Tl("dangling-ancestor-surfaces-a-gap",
     "the parent is not in the prefix; the chain MUST begin with an explicit gap marker. " +
     "A truncated chain that looks complete turns 'I could not see the origin' into 'this is the origin'.",
     s.facts, B.id); }
{ const s = scn(); const A = s.add(1, { type: "build", author: "a", ts: 1 });
  s.add(2, { type: "test", author: "a", ts: 2, refs: { parent: A.id } });
  s.add(3, { type: "lint", author: "a", ts: 3, refs: { parent: A.id } });
  const D = s.add(4, { type: "test", author: "a", ts: 4, refs: { parent: A.id }, nonce: "d" });
  s.add(5, { type: "deploy", author: "a", ts: 5, refs: { parent: D.id } });
  Tl("descendants-over-a-fork", "transitive, seq-ordered, F excluded", s.facts, A.id); }
{ const s = scn(); s.add(1, { type: "orphan", author: "a", ts: 1, refs: { parent: "f".repeat(64) } });
  Tl("descendants-of-an-absent-fact",
     "the trail BELOW an unseen fact is still knowable; the trail above it is not, and the absent " +
     "fact MUST NOT be reported as a root",
     s.facts, "f".repeat(64)); }

const vectors = {
  version: "3.0",
  description:
    "AntLegion Protocol v3.0 conformance vectors. hash[] = JCS canonical string + content address (§4.1); " +
    "folds[] = the normative reader folds of §3. A conforming implementation MUST reproduce every value " +
    "byte-for-byte. Fold coverage is the point: a verifier that reproduces every id while checking no fold " +
    "result gives no evidence about §3, which is where all the meaning is.",
  secret: SECRET,
  defaults: { claimTimeout: DELTA, quorum: 2 },
  hash,
  folds: {
    lifecycle: lifecycleVecs,
    trust: trustVecs,
    register: registerVecs,
    trail: trailVecs,
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), "vectors.json");
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n", "utf-8");
console.log(
  `wrote ${out}: ${hash.length} hash + ` +
  `${lifecycleVecs.length} lifecycle + ${trustVecs.length} trust + ` +
  `${registerVecs.length} register + ${trailVecs.length} trail vectors`,
);
