import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fact } from "../src/types.js";
import { trust, isSuperseded, supersededBy, causationChain, isGap, lifecycle } from "../src/fold.js";
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
  it("superseded beats trust — but only an AUTHORIZED supersede", () => {
    // §5.1: only the target's own author may supersede it. Because `superseded`
    // outranks every vote, an ungated `supersedes` let any author silence any
    // fact's trust state with a single append.
    const authorized = [target, vote(2, "a", "corroborate"), vote(3, "b", "corroborate"),
                        f({ seq: 4, author: "owner", refs: { supersedes: "F" } })];
    expect(trust(authorized, "F")).toBe("superseded");

    const hijack = [target, vote(2, "a", "corroborate"), vote(3, "b", "corroborate"),
                    f({ seq: 4, author: "mallory", refs: { supersedes: "F" } })];
    expect(trust(hijack, "F")).toBe("consensus");
  });

  it("a retracted fact folds to `retracted`, outranking consensus", () => {
    // §3.3/§5.3: v2.0 had no state for this, so a tombstoned fact could fold to consensus.
    const s = [target, vote(2, "a", "corroborate"), vote(3, "b", "corroborate"),
               f({ seq: 4, author: "owner", type: "_.tombstone", refs: { tombstones: "F" } })];
    expect(trust(s, "F")).toBe("retracted");
  });

  it("a vote with an unrecognized verdict does not occupy its author's slot", () => {
    const s = [target, vote(2, "a", "corroborate"), vote(3, "a", "maybe")];
    expect(trust(s, "F", 1)).toBe("consensus");
  });

  it("quorum MUST be >= 1, and an absent target is not foldable", () => {
    expect(() => trust([target], "F", 0)).toThrow(RangeError);
    expect(() => trust([target], "missing")).toThrow(/not in the prefix/);
  });
});

describe("v2 fold — supersession (§3.3)", () => {
  it("explicit supersedes marks the target superseded — from its own author", () => {
    const s = [target, f({ seq: 2, author: "owner", refs: { supersedes: "F" } })];
    expect(isSuperseded(s, "F")).toBe(true);
    expect(supersededBy(s, "F")).toBe("id2");
  });

  it("a stranger's supersedes is ignored (§5.1)", () => {
    const s = [target, f({ seq: 2, author: "mallory", refs: { supersedes: "F" } })];
    expect(isSuperseded(s, "F")).toBe(false);
    expect(supersededBy(s, "F")).toBe(null);
  });

  it("supersededBy returns the IMMEDIATE successor, not the latest", () => {
    // §3.1: "what replaced F" is the next statement; the latest is current(S).
    const a = f({ seq: 1, id: "A", refs: { subject: "deploy" } });
    const b = f({ seq: 2, id: "B", refs: { subject: "deploy" } });
    const c = f({ seq: 3, id: "C", refs: { subject: "deploy" } });
    expect(supersededBy([a, b, c], "A")).toBe("B");
  });

  it("a retracted successor supersedes nothing", () => {
    const a = f({ seq: 1, id: "A", author: "owner" });
    const b = f({ seq: 2, id: "B", author: "owner", refs: { supersedes: "A" } });
    const t = f({ seq: 3, author: "owner", type: "_.tombstone", refs: { tombstones: "B" } });
    expect(supersededBy([a, b], "A")).toBe("B");
    expect(supersededBy([a, b, t], "A")).toBe(null);
  });
  it("subject group: older is superseded, newest is current", () => {
    const a = f({ seq: 1, id: "A", refs: { subject: "deploy" } });
    const b = f({ seq: 2, id: "B", refs: { subject: "deploy" } });
    expect(isSuperseded([a, b], "A")).toBe(true);
    expect(supersededBy([a, b], "A")).toBe("B");
    expect(isSuperseded([a, b], "B")).toBe(false);
  });
  it("a tombstone is NOT supersession (retracted ≠ replaced)", () => {
    const s = [target, f({ seq: 2, author: "owner", type: "_.tombstone", refs: { tombstones: "F" } })];
    expect(isSuperseded(s, "F")).toBe(false);   // not superseded …
    expect(lifecycle(s, "F", { now: 1000 }).state).toBe("dead"); // … it is dead
  });

  it("a stranger's tombstone retracts nothing", () => {
    // v2.0's data-destruction primitive: any writer could drive any fact to a
    // terminal state, fold its register to null, and license compaction to
    // destroy its payload.
    const s = [target, f({ seq: 2, author: "mallory", type: "_.tombstone", refs: { tombstones: "F" } })];
    expect(lifecycle(s, "F", { now: 1000 }).state).toBe("open");
  });
});

describe("v2 fold — causation (§3.4) + compaction durability (§5.2)", () => {
  it("walks parent links root→F", () => {
    const a = f({ seq: 1, id: "A" });
    const b = f({ seq: 2, id: "B", refs: { parent: "A" } });
    const c = f({ seq: 3, id: "C", refs: { parent: "B" } });
    expect(causationChain([a, b, c], "C").map((x) => (isGap(x) ? x : x.id))).toEqual(["A", "B", "C"]);
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
