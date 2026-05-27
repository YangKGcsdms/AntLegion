import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fact } from "../src/types.js";
import { trust, isSuperseded, supersededBy, causationChain, lifecycle } from "../src/fold.js";
import { BusV2 } from "../src/bus.js";

function f(o: {
  seq: number; author?: string; refs?: Fact["refs"]; type?: string;
  payload?: Record<string, unknown>; id?: string; recv?: number;
}): Fact {
  return {
    seq: o.seq, recv: o.recv ?? 1000, id: o.id ?? "id" + o.seq, type: o.type ?? "x",
    author: o.author ?? "a", ts: 1, payload: o.payload ?? {}, refs: o.refs ?? {}, sig: "",
  };
}
const vote = (seq: number, author: string, verdict: string) =>
  f({ seq, author, type: "_.vote", refs: { vote: "F" }, payload: { verdict } });

const target = f({ seq: 1, author: "owner", id: "F" });

describe("v2 fold — trust (§3.2)", () => {
  it("no votes → asserted", () => {
    expect(trust([target], "F")).toBe("asserted");
  });
  it("one corroborate → corroborated; quorum (2) → consensus", () => {
    expect(trust([target, vote(2, "a", "corroborate")], "F")).toBe("corroborated");
    expect(trust([target, vote(2, "a", "corroborate"), vote(3, "b", "corroborate")], "F")).toBe("consensus");
  });
  it("one contradict → contested; quorum → refuted", () => {
    expect(trust([target, vote(2, "a", "contradict")], "F")).toBe("contested");
    expect(trust([target, vote(2, "a", "contradict"), vote(3, "b", "contradict")], "F")).toBe("refuted");
  });
  it("ignores self-votes", () => {
    expect(trust([target, vote(2, "owner", "corroborate")], "F")).toBe("asserted");
  });
  it("counts only each author's latest vote (no flip-flop double-count)", () => {
    // 'a' contradicts then changes mind to corroborate; 'b' corroborates
    const s = [target, vote(2, "a", "contradict"), vote(3, "b", "corroborate"), vote(4, "a", "corroborate")];
    expect(trust(s, "F")).toBe("consensus"); // a(latest=corrob) + b = 2 corroborate, 0 contradict
  });
  it("superseded beats trust", () => {
    const s = [target, vote(2, "a", "corroborate"), vote(3, "b", "corroborate"),
               f({ seq: 4, author: "x", refs: { supersedes: "F" } })];
    expect(trust(s, "F")).toBe("superseded");
  });
});

describe("v2 fold — supersession (§3.3)", () => {
  it("explicit supersedes marks the target superseded", () => {
    const s = [target, f({ seq: 2, author: "x", refs: { supersedes: "F" } })];
    expect(isSuperseded(s, "F")).toBe(true);
    expect(supersededBy(s, "F")).toBe("id2");
  });
  it("subject group: older is superseded, newest is current", () => {
    const a = f({ seq: 1, id: "A", refs: { subject: "deploy" } });
    const b = f({ seq: 2, id: "B", refs: { subject: "deploy" } });
    expect(isSuperseded([a, b], "A")).toBe(true);
    expect(supersededBy([a, b], "A")).toBe("B");
    expect(isSuperseded([a, b], "B")).toBe(false);
  });
  it("a tombstone is NOT supersession (deleted ≠ replaced)", () => {
    const s = [target, f({ seq: 2, author: "gc", type: "_.tombstone", refs: { tombstones: "F" } })];
    expect(isSuperseded(s, "F")).toBe(false);   // not superseded …
    expect(lifecycle(s, "F", { now: 1000 }).state).toBe("dead"); // … it is dead
  });
});

describe("v2 fold — causation (§3.4) + compaction durability (§5.2)", () => {
  it("walks parent links root→F", () => {
    const a = f({ seq: 1, id: "A" });
    const b = f({ seq: 2, id: "B", refs: { parent: "A" } });
    const c = f({ seq: 3, id: "C", refs: { parent: "B" } });
    expect(causationChain([a, b, c], "C").map((x) => x.id)).toEqual(["A", "B", "C"]);
  });

  it("causation survives compaction: ancestor keeps its skeleton, not a gap", () => {
    const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-"));
    const bus = new BusV2({ secret: "s", dataDir: dir });
    const a = bus.append({ type: "root", author: "x", ts: 1, payload: { big: "data" } });
    const b = bus.append({ type: "child", author: "x", ts: 2, refs: { parent: a.id } });
    bus.append({ type: "_.tombstone", author: "gc", ts: 3, refs: { tombstones: a.id }, nonce: "1" });

    const stripped = bus.compact(new Set([a.id]));
    expect(stripped).toBe(1);

    const chain = causationChain(bus.all(), b.id);
    expect(chain.map((x) => x.id)).toEqual([a.id, b.id]); // no gap
    expect(chain[0].payload).toEqual({});                 // payload dropped …
    expect(chain[0].author).toBe("x");                    // … but skeleton kept

    // and it persists across restart
    const bus2 = new BusV2({ secret: "s", dataDir: dir });
    const chain2 = causationChain(bus2.all(), b.id);
    expect(chain2.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(chain2[0].payload).toEqual({});
  });
});
