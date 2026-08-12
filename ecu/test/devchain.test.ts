/**
 * devchain fold tests — the shared worldview must be nailed down: every DCU
 * and the board fold the same stream into the same chain state.
 */

import { describe, expect, it } from "vitest";
import type { Fact } from "antlegion-bus/types";
import {
  DEVCHAIN, EVIDENCE_ACCEPTED, EVIDENCE_REJECTED, GATE_APPROVED,
  foldDevchain, pendingAdjudications,
} from "../src/folds/devchain.js";

let seq = 0;
function fact(partial: Partial<Fact> & { type: string; author: string }): Fact {
  seq += 1;
  return {
    seq, recv: 1000 + seq, id: partial.id ?? `f${seq}`, ts: 1000 + seq,
    payload: {}, refs: {}, sig: "sig",
    ...partial,
  } as Fact;
}

const NOW = { now: 1000, claimTimeout: 600 }; // recv ≈ 1000+seq → nothing expires

const reqFact = () => fact({
  type: "req.registered", author: "ingestor-req@ecu", id: "REQ",
  payload: { slug: "demo", name: "演示需求", origin: "dcu" },
  refs: { subject: "demo" },
});

const goodPlanPayload = {
  reqSlug: "demo", scope: "做 X",
  out_of_scope: ["不做 Y"], acceptance: ["单测过且列明未覆盖项"],
};
const goodDevPayload = {
  reqSlug: "demo", branch: "feature/demo",
  changed_files: ["a.java"], consumers_checked: ["grep ok"],
};
const goodUnitPayload = {
  reqSlug: "demo", passed: 10, failed: 0, not_covered: ["并发场景"],
};
const goodE2ePayload = {
  reqSlug: "demo", api_assertions: 27, page_checked: true,
  deviations: [], defects: [], gaps: ["真实数据未验"],
};

/** Happy-path stream builder up to a point. */
function stream(...parts: Fact[][]): Fact[] { return parts.flat(); }

const claim = (F: string, author: string) =>
  fact({ type: "_.claim", author, refs: { claim_of: F } });
const resolve = (F: string, author: string) =>
  fact({ type: "_.resolve", author, refs: { resolves: F } });
const accept = (F: string) =>
  fact({ type: EVIDENCE_ACCEPTED, author: "dcu-adjudicator@devchain", payload: { stage: "x" }, refs: { verdict_of: F } });
const reject = (F: string, missing: string[]) =>
  fact({ type: EVIDENCE_REJECTED, author: "dcu-adjudicator@devchain", payload: { missing }, refs: { verdict_of: F } });

describe("foldDevchain — stage progression", () => {
  it("a fresh requirement: plan open, everything else waiting", () => {
    seq = 0;
    const views = foldDevchain([reqFact()], NOW);
    expect(views).toHaveLength(1);
    const v = views[0]!;
    expect(v.slug).toBe("demo");
    expect(v.stages.map((s) => s.state)).toEqual(["open", "waiting", "waiting", "waiting"]);
    expect(v.stages[0]!.inputId).toBe("REQ");
  });

  it("claimed input → working with owner", () => {
    seq = 0;
    const views = foldDevchain(stream([reqFact()], [claim("REQ", "dcu-plan@devchain")]), NOW);
    expect(views[0]!.stages[0]!.state).toBe("working");
    expect(views[0]!.stages[0]!.owner).toBe("dcu-plan@devchain");
  });

  it("resolved + artifact → adjudicating; accepted → done; dev becomes gated", () => {
    seq = 0;
    const s = stream(
      [reqFact(), claim("REQ", "dcu-plan@devchain"), resolve("REQ", "dcu-plan@devchain")],
      [fact({ type: "plan.ready", author: "dcu-plan@devchain", id: "PLAN", payload: goodPlanPayload, refs: { parent: "REQ", subject: "demo" } })],
    );
    expect(foldDevchain(s, NOW)[0]!.stages[0]!.state).toBe("adjudicating");

    s.push(accept("PLAN"));
    const v = foldDevchain(s, NOW)[0]!;
    expect(v.stages[0]!.state).toBe("done");
    expect(v.stages[1]!.state).toBe("gated"); // H1 not approved yet
    expect(v.stages[1]!.inputId).toBe("PLAN");
  });

  it("gate.approved unlocks dev to open", () => {
    seq = 0;
    const s = stream(
      [reqFact(), claim("REQ", "dcu-plan@devchain"), resolve("REQ", "dcu-plan@devchain")],
      [fact({ type: "plan.ready", author: "dcu-plan@devchain", id: "PLAN", payload: goodPlanPayload, refs: { parent: "REQ" } })],
      [accept("PLAN")],
      [fact({ type: GATE_APPROVED, author: "carter@board", payload: { gate: "H1" }, refs: { gate_of: "PLAN" } })],
    );
    const v = foldDevchain(s, NOW)[0]!;
    expect(v.stages[1]!.state).toBe("open");
    expect(v.stages[1]!.gate?.approvedBy).toBe("carter@board");
  });

  it("full happy chain → every stage done, chain done", () => {
    seq = 0;
    const s = stream(
      [reqFact(), claim("REQ", "dcu-plan@devchain"), resolve("REQ", "dcu-plan@devchain")],
      [fact({ type: "plan.ready", author: "dcu-plan@devchain", id: "PLAN", payload: goodPlanPayload, refs: { parent: "REQ" } })],
      [accept("PLAN")],
      [fact({ type: GATE_APPROVED, author: "carter@board", payload: { gate: "H1" }, refs: { gate_of: "PLAN" } })],
      [claim("PLAN", "dcu-dev@devchain"), resolve("PLAN", "dcu-dev@devchain")],
      [fact({ type: "dev.done", author: "dcu-dev@devchain", id: "DEV", payload: goodDevPayload, refs: { parent: "PLAN" } })],
      [accept("DEV")],
      [claim("DEV", "dcu-unittest@devchain"), resolve("DEV", "dcu-unittest@devchain")],
      [fact({ type: "test.unit.report", author: "dcu-unittest@devchain", id: "UNIT", payload: goodUnitPayload, refs: { parent: "DEV" } })],
      [accept("UNIT")],
      [claim("UNIT", "dcu-e2e@devchain"), resolve("UNIT", "dcu-e2e@devchain")],
      [fact({ type: "e2e.report", author: "dcu-e2e@devchain", id: "E2E", payload: goodE2ePayload, refs: { parent: "UNIT" } })],
      [accept("E2E")],
    );
    const v = foldDevchain(s, NOW)[0]!;
    expect(v.stages.map((x) => x.state)).toEqual(["done", "done", "done", "done"]);
    expect(v.done).toBe(true);
  });

  it("a rejected artifact halts the chain — downstream stays waiting", () => {
    seq = 0;
    const badUnit = { reqSlug: "demo", passed: 10, failed: 0 }; // missing not_covered
    const s = stream(
      [reqFact(), claim("REQ", "dcu-plan@devchain"), resolve("REQ", "dcu-plan@devchain")],
      [fact({ type: "plan.ready", author: "dcu-plan@devchain", id: "PLAN", payload: goodPlanPayload, refs: { parent: "REQ" } })],
      [accept("PLAN")],
      [fact({ type: GATE_APPROVED, author: "carter@board", payload: { gate: "H1" }, refs: { gate_of: "PLAN" } })],
      [claim("PLAN", "dcu-dev@devchain"), resolve("PLAN", "dcu-dev@devchain")],
      [fact({ type: "dev.done", author: "dcu-dev@devchain", id: "DEV", payload: goodDevPayload, refs: { parent: "PLAN" } })],
      [accept("DEV")],
      [claim("DEV", "dcu-unittest@devchain"), resolve("DEV", "dcu-unittest@devchain")],
      [fact({ type: "test.unit.report", author: "dcu-unittest@devchain", id: "UNIT", payload: badUnit, refs: { parent: "DEV" } })],
      [reject("UNIT", ["not_covered"])],
    );
    const v = foldDevchain(s, NOW)[0]!;
    expect(v.stages[2]!.state).toBe("rejected");
    expect(v.stages[2]!.verdict?.missing).toEqual(["not_covered"]);
    expect(v.stages[3]!.state).toBe("waiting");
    expect(v.done).toBe(false);
  });
});

describe("pendingAdjudications", () => {
  it("returns artifacts until a verdict exists", () => {
    seq = 0;
    const plan = fact({ type: "plan.ready", author: "dcu-plan@devchain", id: "PLAN", payload: goodPlanPayload, refs: { parent: "REQ" } });
    const s = [reqFact(), plan];
    expect(pendingAdjudications(s).map((f) => f.id)).toEqual(["PLAN"]);
    s.push(accept("PLAN"));
    expect(pendingAdjudications(s)).toHaveLength(0);
  });
});

describe("evidence rules — 做完了 ≠ 验证过了, as shape", () => {
  it("plan: missing 不做什么/验收口径 is invalid", () => {
    expect(DEVCHAIN.plan.evidence.check(goodPlanPayload)).toEqual([]);
    expect(DEVCHAIN.plan.evidence.check({ scope: "x", out_of_scope: [], acceptance: ["a"] })).toEqual(["out_of_scope"]);
  });

  it("dev: consumers_checked is mandatory (invariant discipline)", () => {
    expect(DEVCHAIN.dev.evidence.check(goodDevPayload)).toEqual([]);
    expect(DEVCHAIN.dev.evidence.check({ branch: "b", changed_files: ["f"] })).toEqual(["consumers_checked"]);
  });

  it("unittest: a report without not_covered is invalid, not passing", () => {
    expect(DEVCHAIN.unittest.evidence.check(goodUnitPayload)).toEqual([]);
    expect(DEVCHAIN.unittest.evidence.check({ passed: 1, failed: 0, not_covered: [] })).toEqual(["not_covered"]);
  });

  it("e2e: page_checked must be true and all three sections present", () => {
    expect(DEVCHAIN.e2e.evidence.check(goodE2ePayload)).toEqual([]);
    expect(DEVCHAIN.e2e.evidence.check({ api_assertions: 27, page_checked: false, deviations: [], defects: [], gaps: [] }))
      .toEqual(["page_checked"]);
    expect(DEVCHAIN.e2e.evidence.check({ api_assertions: 27, page_checked: true, deviations: [], defects: [] }))
      .toEqual(["gaps"]);
  });
});
