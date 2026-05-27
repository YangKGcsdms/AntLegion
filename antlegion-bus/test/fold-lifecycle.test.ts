import { describe, it, expect } from "vitest";
import type { Fact } from "../src/types.js";
import { lifecycle, claimWinner, didIWin } from "../src/fold.js";

/** Craft a stored fact with explicit seq/recv for precise fold testing. */
function f(seq: number, author: string, refs: Fact["refs"], recv = 1000, type = "x"): Fact {
  return { seq, recv, id: "id" + seq, type, author, ts: 1, payload: {}, refs, sig: "" };
}

const F = "F";

describe("v2 fold — lifecycle", () => {
  it("a single claim makes F claimed by that author", () => {
    const s = [f(1, "W", { claim_of: F })];
    expect(lifecycle(s, F, { now: 1000 })).toEqual({ state: "claimed", owner: "W" });
  });

  it("lowest-seq claim wins (exactly-once is a theorem of order)", () => {
    const s = [f(1, "W", { claim_of: F }), f(2, "V", { claim_of: F })];
    expect(claimWinner(s, F, { now: 1000 })).toBe("W");
  });

  it("when the winner releases, the next-lowest live claim wins", () => {
    const s = [f(1, "W", { claim_of: F }), f(2, "V", { claim_of: F }), f(3, "W", { release_of: F })];
    expect(claimWinner(s, F, { now: 1000 })).toBe("V");
  });

  it("a resolve from the winner makes F resolved", () => {
    const s = [f(1, "W", { claim_of: F }), f(2, "W", { resolves: F })];
    expect(lifecycle(s, F, { now: 1000 })).toEqual({ state: "resolved", owner: "W" });
  });

  it("a resolve from a non-winner is ignored", () => {
    const s = [f(1, "W", { claim_of: F }), f(2, "V", { resolves: F })];
    expect(lifecycle(s, F, { now: 1000 })).toEqual({ state: "claimed", owner: "W" });
  });

  it("a timed-out claim is not live; a later live claim takes over", () => {
    const s = [f(1, "W", { claim_of: F }, 1000), f(2, "V", { claim_of: F }, 2500)];
    // Δ=600; at now=2700 W aged 1700 (out), V aged 200 (live)
    expect(claimWinner(s, F, { now: 2700, claimTimeout: 600 })).toBe("V");
  });

  it("a claim with no successor times out to open (re-dispatchable)", () => {
    const s = [f(1, "W", { claim_of: F }, 1000)];
    expect(lifecycle(s, F, { now: 2000, claimTimeout: 600 })).toEqual({ state: "open", owner: null });
  });

  it("a tombstone makes F dead", () => {
    const s = [f(1, "W", { claim_of: F }), f(2, "gc", { tombstones: F }, 1000, "_.tombstone")];
    expect(lifecycle(s, F, { now: 1000 }).state).toBe("dead");
  });

  it("didIWin reflects the deterministic winner", () => {
    const s = [f(1, "W", { claim_of: F }), f(2, "V", { claim_of: F })];
    expect(didIWin(s, F, "W", { now: 1000 })).toBe(true);
    expect(didIWin(s, F, "V", { now: 1000 })).toBe(false);
  });

  // ── the probe: a resolve issued before its claim times out is terminal —
  //    a later timeout (and a late losing competitor) must not undo it. ──
  it("resolved stays resolved; a later timeout never undoes a real completion", () => {
    const s = [
      f(1, "W", { claim_of: F }, 1000),  // W wins
      f(2, "W", { resolves: F }, 1100),  // W completes within Δ (recv monotonic with seq)
      f(3, "V", { claim_of: F }, 2500),  // V claims late — too late, already resolved
    ];
    expect(lifecycle(s, F, { now: 2700, claimTimeout: 600 })).toEqual({ state: "resolved", owner: "W" });
  });

  it("a timed-out claim is re-dispatchable: the recovering claimant's resolve is honored", () => {
    const s = [
      f(1, "crashed", { claim_of: F }, 1000), // claims then never resolves
      f(2, "rescuer", { claim_of: F }, 2500), // claims after timeout (recv past 1000+600)
      f(3, "rescuer", { resolves: F }, 2600), // and completes it
    ];
    expect(lifecycle(s, F, { now: 2700, claimTimeout: 600 })).toEqual({ state: "resolved", owner: "rescuer" });
  });
});
