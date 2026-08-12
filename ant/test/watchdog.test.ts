/**
 * watchdog fold tests — exception detection must be exact: the inbox is the
 * only place a human looks, so false positives train the human to ignore it
 * and false negatives hide real fires.
 */

import { describe, expect, it } from "vitest";
import type { Fact } from "@antlegion/bus/types";
import { foldDevchain } from "../src/folds/devchain.js";
import {
  alreadyReported, detectEscalations, detectOrphanRejections, detectStarved,
} from "../src/folds/watchdog.js";

let seq = 0;
function fact(partial: Partial<Fact> & { type: string; author: string }): Fact {
  seq += 1;
  return {
    seq, recv: 1000 + seq, id: partial.id ?? `f${seq}`, ts: 1000 + seq,
    payload: {}, refs: {}, sig: "sig",
    ...partial,
  } as Fact;
}

const FOLD_NOW = { now: 1000, claimTimeout: 600 };

const reqFact = () => fact({
  type: "req.registered", author: "ingestor-req@ant", id: "REQ",
  payload: { slug: "demo", name: "演示需求", origin: "dcu" },
  refs: { subject: "demo" },
});
const goodPlanPayload = {
  reqSlug: "demo", scope: "做 X", out_of_scope: ["不做 Y"], acceptance: ["验收"],
};

describe("detectStarved", () => {
  it("an open stage past the threshold is starved; a fresh one is not", () => {
    seq = 0;
    const s = [reqFact()]; // plan open, input REQ at recv 1001
    const views = foldDevchain(s, FOLD_NOW);
    expect(detectStarved(s, views, 1001 + 30, 60)).toHaveLength(0);
    const starved = detectStarved(s, views, 1001 + 120, 60);
    expect(starved).toHaveLength(1);
    expect(starved[0]).toMatchObject({ reqSlug: "demo", stage: "plan", inputId: "REQ" });
  });

  it("anchor advances to the latest prerequisite (gate approval), not req birth", () => {
    seq = 0;
    const s = [
      reqFact(),
      fact({ type: "_.claim", author: "dcu-plan@devchain", refs: { claim_of: "REQ" } }),
      fact({ type: "_.resolve", author: "dcu-plan@devchain", refs: { resolves: "REQ" } }),
      fact({ type: "plan.ready", author: "dcu-plan@devchain", id: "PLAN", payload: goodPlanPayload, refs: { parent: "REQ" } }),
      fact({ type: "evidence.accepted", author: "dcu-adjudicator@devchain", refs: { verdict_of: "PLAN" } }),
      // gate approved much later: recv 1006
      fact({ type: "gate.approved", author: "carter@board", payload: { gate: "H1" }, refs: { gate_of: "PLAN" } }),
    ];
    const views = foldDevchain(s, FOLD_NOW);
    expect(views[0]!.stages[1]!.state).toBe("open");
    // 30s after the gate → not starved even though the req is much older.
    expect(detectStarved(s, views, 1006 + 30, 60)).toHaveLength(0);
    // 120s after the gate → starved, anchored on the gate's recv.
    const starved = detectStarved(s, views, 1006 + 120, 60);
    expect(starved).toHaveLength(1);
    expect(starved[0]).toMatchObject({ stage: "dev", inputId: "PLAN" });
  });

  it("a claimed (working) stage is never starved", () => {
    seq = 0;
    const s = [reqFact(), fact({ type: "_.claim", author: "dcu-plan@devchain", refs: { claim_of: "REQ" } })];
    // evaluate inside the claim window so the stage is `working`
    const views = foldDevchain(s, { now: 1002 + 60, claimTimeout: 600 });
    expect(views[0]!.stages[0]!.state).toBe("working");
    expect(detectStarved(s, views, 1002 + 60, 10)).toHaveLength(0);
  });
});

describe("detectEscalations", () => {
  it("a rejected artifact escalates with the missing fields", () => {
    seq = 0;
    const s = [
      reqFact(),
      fact({ type: "_.claim", author: "dcu-plan@devchain", refs: { claim_of: "REQ" } }),
      fact({ type: "_.resolve", author: "dcu-plan@devchain", refs: { resolves: "REQ" } }),
      fact({ type: "plan.ready", author: "dcu-plan@devchain", id: "PLAN", payload: { reqSlug: "demo", scope: "x" }, refs: { parent: "REQ" } }),
      fact({ type: "evidence.rejected", author: "dcu-adjudicator@devchain", payload: { missing: ["out_of_scope", "acceptance"] }, refs: { verdict_of: "PLAN" } }),
    ];
    const views = foldDevchain(s, FOLD_NOW);
    expect(views[0]!.stages[0]!.state).toBe("rejected");
    const esc = detectEscalations(s, views);
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ reqSlug: "demo", stage: "plan", factId: "PLAN", reason: "evidence_rejected" });
  });

  it("claim churn: an input open again after N expired claims is a poison pill", () => {
    seq = 0;
    const s = [reqFact()];
    // three claims, all long expired by evaluation time
    for (let i = 0; i < 3; i++) {
      s.push(fact({ type: "_.claim", author: `dcu-plan-${i}@devchain`, refs: { claim_of: "REQ" } }));
    }
    const now = 1004 + 700; // beyond claimTimeout → stage folds back to open
    const views = foldDevchain(s, { now, claimTimeout: 600 });
    expect(views[0]!.stages[0]!.state).toBe("open");
    const esc = detectEscalations(s, views, 3);
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ factId: "REQ", reason: "claim_churn" });
    // below the limit → no escalation
    expect(detectEscalations(s, views, 4)).toHaveLength(0);
  });
});

describe("detectOrphanRejections", () => {
  it("a stray rejected artifact (not on any chain) still escalates", () => {
    seq = 0;
    const s = [
      reqFact(),
      // hand-published artifact with no parent linkage to any stage input
      fact({ type: "test.unit.report", author: "someone@cli", id: "STRAY", payload: { reqSlug: "demo", passed: 1, failed: 0 } }),
      fact({ type: "evidence.rejected", author: "dcu-adjudicator@devchain", payload: { stage: "unittest", missing: ["not_covered"] }, refs: { verdict_of: "STRAY" } }),
    ];
    const views = foldDevchain(s, FOLD_NOW);
    const esc = detectOrphanRejections(s, views);
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ factId: "STRAY", stage: "unittest", reason: "evidence_rejected" });
  });
});

describe("alreadyReported", () => {
  it("collects fact ids covered by published watchdog facts", () => {
    seq = 0;
    const s = [
      fact({ type: "chain.starved", author: "dcu-watchdog@devchain", refs: { starves: "A" } }),
      fact({ type: "escalate.human", author: "dcu-watchdog@devchain", refs: { escalates: "B" } }),
      fact({ type: "escalate.human", author: "dcu-watchdog@devchain", refs: {} }),
    ];
    expect(alreadyReported(s)).toEqual(new Set(["A", "B"]));
  });
});
