/**
 * identity-conflict fold tests (计划 13 §三.3): 检测代替禁止 —
 * a double-started author must be FOLDED OUT of the heartbeat stream.
 */
import { describe, expect, it } from "vitest";
import type { Fact } from "@antlegion/bus/types";
import {
  conflictPairKey, detectIdentityConflicts, reportedConflicts, IDENTITY_CONFLICT,
} from "../src/folds/identity.js";
import { SYS_HEARTBEAT } from "../src/runtime.js";

let seq = 0;
const hb = (author: string, instance: string, recv: number): Fact => ({
  seq: ++seq, recv, id: `hb-${seq}`, type: SYS_HEARTBEAT, author,
  ts: recv, payload: { instance, n: seq }, refs: {}, sig: "x",
} as Fact);

describe("detectIdentityConflicts", () => {
  it("two live tokens under one author → conflict", () => {
    const now = 1000;
    const stream = [
      hb("dev@projA", "tok-a", 990),
      hb("dev@projA", "tok-b", 995),
    ];
    const cs = detectIdentityConflicts(stream, 40, now);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.author).toBe("dev@projA");
    expect(cs[0]!.tokens).toEqual(["tok-a", "tok-b"]);
    expect(cs[0]!.heartbeats).toEqual(["hb-1", "hb-2"]);
  });

  it("a replaced instance (restart) is NOT a conflict once the old token ages out", () => {
    const now = 1000;
    const stream = [
      hb("dev@projA", "tok-old", 900), // died 100s ago, window 40s
      hb("dev@projA", "tok-new", 995),
    ];
    expect(detectIdentityConflicts(stream, 40, now)).toEqual([]);
  });

  it("single token beating repeatedly is never a conflict", () => {
    const stream = [hb("dev@projA", "tok-a", 980), hb("dev@projA", "tok-a", 990)];
    expect(detectIdentityConflicts(stream, 40, 1000)).toEqual([]);
  });

  it("different authors never conflict with each other", () => {
    const stream = [hb("dev@projA", "tok-a", 990), hb("dev@projB", "tok-b", 995)];
    expect(detectIdentityConflicts(stream, 40, 1000)).toEqual([]);
  });

  it("keys on recv (bus time), ignoring the author-stated ts", () => {
    const f = hb("dev@projA", "tok-a", 990);
    (f as { ts: number }).ts = 1; // absurd author clock — must not matter
    const stream = [f, hb("dev@projA", "tok-b", 992)];
    expect(detectIdentityConflicts(stream, 40, 1000)).toHaveLength(1);
  });
});

describe("conflictPairKey / reportedConflicts", () => {
  it("pair key is order-independent — one fact per pair, ever", () => {
    expect(conflictPairKey("a@x", "t2", "t1")).toBe(conflictPairKey("a@x", "t1", "t2"));
  });

  it("reported pairs are folded from the stream, not remembered in-process", () => {
    const conflictFact = {
      seq: 99, recv: 999, id: "c1", type: IDENTITY_CONFLICT, author: "dcu-watchdog@projA",
      ts: 999, payload: { pair_key: "dev@projA|t1|t2" }, refs: {}, sig: "x",
    } as Fact;
    const known = reportedConflicts([conflictFact]);
    expect(known.has("dev@projA|t1|t2")).toBe(true);
    expect(known.has("other")).toBe(false);
  });
});
