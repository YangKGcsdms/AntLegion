/**
 * fold-colony.test.ts — §7 colony/orphan + §8 context-gap folds.
 *
 * Uses the real bus so facts get proper ids/seq/recv; the folds run over
 * bus.read() exactly as a supervisor/console would.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import {
  colony, orphanReport, contextGaps,
  SYS_REGISTRY, CONTEXT_REQUESTED, CONTEXT_PROVIDED,
} from "../src/fold.js";

function bus() {
  return new BusV2({ secret: "t", dataDir: mkdtempSync(join(tmpdir(), "antlegion-colony-")) });
}
const pub = (b: BusV2, type: string, author: string, payload: Record<string, unknown> = {}, refs: Record<string, string> = {}) =>
  b.append({ type, author, ts: 0, payload, refs, nonce: `${type}:${author}:${JSON.stringify(payload)}:${JSON.stringify(refs)}` });

describe("§7 colony roster", () => {
  it("collects the latest sys.registry per author, with interests/publishes", () => {
    const b = bus();
    pub(b, SYS_REGISTRY, "planner", { interests: ["req.*"], publishes: ["plan.ready"] });
    pub(b, SYS_REGISTRY, "dev", { interests: ["plan.ready"], publishes: ["dev.done"] });
    const roster = colony(b.read());
    expect(roster.map((r) => r.author)).toEqual(["dev", "planner"]);
    expect(roster.find((r) => r.author === "planner")!.interests).toEqual(["req.*"]);
  });

  it("latest registration wins per author", () => {
    const b = bus();
    pub(b, SYS_REGISTRY, "a", { interests: ["old.*"] });
    pub(b, SYS_REGISTRY, "a", { interests: ["new.*"] });
    const roster = colony(b.read());
    expect(roster.length).toBe(1);
    expect(roster[0].interests).toEqual(["new.*"]);
  });

  it("honors the devchain legacy listens/produces shape", () => {
    const b = bus();
    pub(b, SYS_REGISTRY, "stage", { listens: "req.registered", produces: "plan.ready" });
    const r = colony(b.read())[0];
    expect(r.interests).toEqual(["req.registered"]);
    expect(r.publishes).toEqual(["plan.ready"]);
  });
});

describe("§7 orphan report", () => {
  it("flags a fact type no registered interest matches", () => {
    const b = bus();
    pub(b, SYS_REGISTRY, "planner", { interests: ["req.*"], publishes: ["plan.ready"] });
    pub(b, "req.registered", "carter", { title: "x" });   // matched by planner's req.*
    pub(b, "weird.signal", "sensor", { v: 1 });            // nobody is interested → orphan
    pub(b, "weird.signal", "sensor", { v: 2 });
    const rep = orphanReport(b.read());
    expect(rep.orphanTypes.map((o) => o.type)).toEqual(["weird.signal"]);
    expect(rep.orphanTypes[0].count).toBe(2);
    expect(rep.orphanTypes[0].sampleIds.length).toBe(2);
  });

  it("ignores mechanical types (_.claim, sys.*) in orphan analysis", () => {
    const b = bus();
    pub(b, SYS_REGISTRY, "w", { interests: ["task.*"], publishes: [] });
    const t = pub(b, "task.x", "carter");
    b.append({ type: "_.claim", author: "w", ts: 0, refs: { claim_of: t.id }, nonce: "c1" });
    const rep = orphanReport(b.read());
    expect(rep.orphanTypes).toEqual([]); // task.x is covered; _.claim & sys.registry excluded
  });

  it("excludes context.* from orphans (contextGaps tracks those with a better signal)", () => {
    const b = bus();
    pub(b, SYS_REGISTRY, "w", { interests: ["task.*"], publishes: [] });
    const thin = pub(b, "task.x", "carter");
    pub(b, CONTEXT_REQUESTED, "w", { question: "?" }, { about: thin.id });
    pub(b, CONTEXT_PROVIDED, "carter", { answer: "here" }, { parent: thin.id });
    const rep = orphanReport(b.read());
    // nobody declares interest in context.* — but they are protocol convention,
    // not un-consumed domain work, so they must not show up as orphans.
    expect(rep.orphanTypes.map((o) => o.type)).toEqual([]);
  });

  it("reports unmatched interests and silent publishes", () => {
    const b = bus();
    pub(b, SYS_REGISTRY, "dev", { interests: ["plan.ready"], publishes: ["dev.done"] });
    // dev listens for plan.ready (never produced) and promises dev.done (never emitted)
    const rep = orphanReport(b.read());
    expect(rep.unmatchedInterests).toEqual([{ author: "dev", interest: "plan.ready" }]);
    expect(rep.silentPublishes).toEqual([{ author: "dev", type: "dev.done" }]);
    expect(rep.registeredAgents).toBe(1);
  });

  it("a silent publish clears once the agent actually emits it", () => {
    const b = bus();
    pub(b, SYS_REGISTRY, "dev", { interests: [], publishes: ["dev.done"] });
    pub(b, "dev.done", "dev", { ok: true });
    expect(orphanReport(b.read()).silentPublishes).toEqual([]);
  });
});

describe("§8 context gaps", () => {
  it("lists a context.requested with no answer, resolved by refs.parent", () => {
    const b = bus();
    const thin = pub(b, "build.failed", "ci", { note: "something broke" });
    const req = pub(b, CONTEXT_REQUESTED, "dev", { question: "which target?" }, { about: thin.id });
    let gaps = contextGaps(b.read());
    expect(gaps.length).toBe(1);
    expect(gaps[0].about).toBe(thin.id);
    expect(gaps[0].question).toBe("which target?");
    expect(gaps[0].answered).toBe(false);

    // answer it → gap closes
    pub(b, CONTEXT_PROVIDED, "ci", { answer: "the arm64 build" }, { parent: req.id });
    gaps = contextGaps(b.read());
    expect(gaps.length).toBe(0);
    expect(contextGaps(b.read(), { includeAnswered: true }).length).toBe(1);
  });

  it("also matches an explicit refs.answers link", () => {
    const b = bus();
    const req = pub(b, CONTEXT_REQUESTED, "dev", { question: "?" }, { about: "deadbeef" });
    pub(b, CONTEXT_PROVIDED, "other", { answer: "here" }, { answers: req.id });
    expect(contextGaps(b.read()).length).toBe(0);
  });
});
