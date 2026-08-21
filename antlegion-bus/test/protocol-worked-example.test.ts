/**
 * PROTOCOL.md §6 — "A complete example: one contested piece of work".
 *
 * The specification prints real content addresses and real fold results so a
 * reader can reproduce them. This suite is what stops those printed values from
 * rotting: it rebuilds the same stream and asserts every id and every fold the
 * document claims. If the protocol changes, this goes red before the prose is
 * wrong in public.
 */

import { describe, it, expect } from "vitest";
import { computeId } from "../src/hash.js";
import { canonicalRecord, type Fact, type FactInput } from "../src/types.js";
import { jcsStringify } from "../src/canonical.js";
import { lifecycle, claimWinner, causationChain, isGap } from "../src/fold.js";

const mk = (seq: number, recv: number, i: FactInput): Fact => ({
  seq, recv, id: computeId(i), type: i.type, author: i.author, ts: i.ts,
  payload: i.payload ?? {}, refs: i.refs ?? {}, ...(i.nonce ? { nonce: i.nonce } : {}), sig: "…",
});

const D = 600;
const at = (now: number) => ({ now, claimTimeout: D });

// The stream exactly as §6.1 prints it.
const f41 = mk(41, 1748300000.4, {
  type: "build.failed", author: "ci-bot", ts: 1748300000, payload: { job: "nightly", exit: 1 },
});
const f42 = mk(42, 1748300012.1, {
  type: "_.claim", author: "agent-a", ts: 1748300012, refs: { claim_of: f41.id }, nonce: "a1",
});
const f43 = mk(43, 1748300012.9, {
  type: "_.claim", author: "agent-b", ts: 1748300012, refs: { claim_of: f41.id }, nonce: "b1",
});
const f44 = mk(44, 1748300210.0, {
  type: "_.claim", author: "agent-a", ts: 1748300210, refs: { claim_of: f41.id }, nonce: "a2",
});
const f45 = mk(45, 1748300455.7, {
  type: "fix.done", author: "agent-a", ts: 1748300455,
  payload: { commit: "9f2c1ab" }, refs: { parent: f41.id, resolves: f41.id }, nonce: "a3",
});
const stream = [f41, f42, f43, f44, f45];

describe("§6.1 — the printed content addresses", () => {
  it("reproduces every id in the table", () => {
    expect(f41.id).toBe("7f2a743a3f3598755651b4c01d6d1fb2b3be5d09b0036545e87d6cfd2b17c45d");
    expect(f42.id).toBe("4d5da059c140d54293a5952ffe9654cc03f5e4cc8103d2a2f4334ce06e47fdf9");
    expect(f43.id).toBe("c605e94b9a550b05d83105bd4281183869ad501e2a21583cd801b8e5da47e1fd");
    expect(f44.id).toBe("919131dd57b3df60aece064d814ae717fa61bc2d69e6143a5be767044463ef57");
    expect(f45.id).toBe("a0266a551b884a3a8542e28b94d717bc61b05bdb4130ea06e718579aa2b92aad");
  });

  it("reproduces the printed canonical form of #41", () => {
    expect(jcsStringify(canonicalRecord({
      type: f41.type, author: f41.author, ts: f41.ts, payload: f41.payload,
    }))).toBe('{"author":"ci-bot","payload":{"exit":1,"job":"nightly"},"ts":1748300000,"type":"build.failed"}');
  });
});

describe("§6.2 — what each step demonstrates", () => {
  it("step 5: a byte-identical resubmit is the same fact", () => {
    const resubmit = computeId({
      type: "_.claim", author: "agent-a", ts: 1748300012, refs: { claim_of: f41.id }, nonce: "a1",
    });
    expect(resubmit).toBe(f42.id);
  });

  it("step 6: a fresh nonce makes a genuinely new fact", () => {
    expect(f44.id).not.toBe(f42.id);
  });

  it("steps 3-4: contention resolves to the lowest seq, computed not announced", () => {
    expect(lifecycle([f41, f42], f41.id, at(1748300013))).toEqual({ state: "claimed", owner: "agent-a" });
    expect(lifecycle([f41, f42, f43], f41.id, at(1748300013))).toEqual({ state: "claimed", owner: "agent-a" });
    expect(claimWinner([f41, f42, f43], f41.id, at(1748300013))).toBe("agent-a");
  });

  it("steps 7-8: the resolve is terminal and every later reader agrees", () => {
    expect(lifecycle(stream, f41.id, at(1748300456))).toEqual({ state: "resolved", owner: "agent-a" });
    expect(lifecycle(stream, f41.id, at(1748399999))).toEqual({ state: "resolved", owner: "agent-a" });
  });

  it("step 7: the chain printed for #45", () => {
    expect(causationChain(stream, f45.id).map((n) => (isGap(n) ? "GAP" : n.id)))
      .toEqual([f41.id, f45.id]);
  });
});

describe("§6.3 — the failure branch", () => {
  const bRetry = mk(46, f44.recv + D + 1, {
    type: "_.claim", author: "agent-b", ts: 1748300860, refs: { claim_of: f41.id }, nonce: "b2",
  });

  it("agent-a's lapsed claim hands over deterministically", () => {
    const crashed = [f41, f42, f43, f44, bRetry];
    expect(lifecycle(crashed, f41.id, at(bRetry.recv + 1)))
      .toEqual({ state: "claimed", owner: "agent-b" });
  });

  it("but a real resolve is never undone by a late claim (§9.3)", () => {
    const late = mk(46, f45.recv + D + 1, {
      type: "_.claim", author: "agent-b", ts: 1, refs: { claim_of: f41.id }, nonce: "b3",
    });
    expect(lifecycle([...stream, late], f41.id, at(f45.recv + D + 99)))
      .toEqual({ state: "resolved", owner: "agent-a" });
  });
});
