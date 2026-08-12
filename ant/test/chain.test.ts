import { describe, it, expect } from "vitest";
import { foldChain, reqAgeSeconds, type FactLike } from "../src/folds/chain.js";

let seq = 0;
function fact(type: string, payload: Record<string, unknown>, recv = 1000): FactLike {
  return { seq: ++seq, recv: recv + seq, type, payload };
}

function req(slug: string, extra: Record<string, unknown> = {}) {
  return fact("req.registered", {
    slug, name: `需求-${slug}`, created: "2026-07-01 09:00", slot: 1,
    branch: `feature/${slug}`, projects: ["workflow-oa"],
    ports: { backend: 21001 }, ...extra,
  });
}

function doc(reqSlug: string, docName: string, status: string | null, mtime = 1000) {
  return fact("doc.updated", { reqSlug, doc: docName, status, mtime, path: `x/docs/${docName}` });
}

describe("foldChain", () => {
  it("folds req.registered facts into requirements ordered by registration seq", () => {
    const s = foldChain([req("beta"), req("alpha")]);
    expect(s.requirements.map((r) => r.slug)).toEqual(["beta", "alpha"]);
    expect(s.requirements[0]).toMatchObject({
      name: "需求-beta", slot: 1, branch: "feature/beta",
      projects: ["workflow-oa"], ports: { backend: 21001 },
    });
  });

  it("re-registration refreshes fields but keeps the original registration marker", () => {
    const f1 = req("alpha", { name: "旧名" });
    const f2 = req("alpha", { name: "新名" });
    const s = foldChain([f1, f2]);
    expect(s.requirements).toHaveLength(1);
    expect(s.requirements[0]!.name).toBe("新名");
    expect(s.requirements[0]!.registeredSeq).toBe(f1.seq);
  });

  it("doc.updated is latest-wins per (reqSlug, doc) by highest seq", () => {
    const s = foldChain([
      req("alpha"),
      doc("alpha", "方案.md", "旧状态"),
      doc("alpha", "方案.md", "新状态"),
      doc("alpha", "报告.md", null),
    ]);
    const docs = s.docsByReq.get("alpha")!;
    expect(docs).toHaveLength(2);
    const plan = docs.find((d) => d.doc === "方案.md")!;
    expect(plan.status).toBe("新状态");
    const report = docs.find((d) => d.doc === "报告.md")!;
    expect(report.status).toBeNull();
  });

  it("empty-string status folds to null", () => {
    const s = foldChain([req("alpha"), doc("alpha", "a.md", "")]);
    expect(s.docsByReq.get("alpha")![0]!.status).toBeNull();
  });

  it("docs for unregistered requirements land in orphanDocs", () => {
    const s = foldChain([doc("ghost", "方案.md", "状态x")]);
    expect(s.requirements).toHaveLength(0);
    expect(s.orphanDocs).toHaveLength(1);
    expect(s.orphanDocs[0]!.reqSlug).toBe("ghost");
  });

  it("ignores unrelated fact types and malformed payloads", () => {
    const s = foldChain([
      fact("ci.build", { ok: true }),
      fact("req.registered", { name: "no slug" }),
      fact("doc.updated", { reqSlug: "x" }), // no doc
      req("alpha"),
    ]);
    expect(s.requirements.map((r) => r.slug)).toEqual(["alpha"]);
  });

  it("is order-independent: shuffled input yields the same fold", () => {
    const facts = [req("a"), doc("a", "d.md", "s1"), req("b"), doc("a", "d.md", "s2")];
    const forward = foldChain(facts);
    const backward = foldChain([...facts].reverse());
    expect(backward.requirements.map((r) => r.slug)).toEqual(forward.requirements.map((r) => r.slug));
    expect(backward.docsByReq.get("a")![0]!.status).toBe("s2");
  });

  it("accepts projects as string or array and slot as string", () => {
    const s = foldChain([req("alpha", { projects: "a b c", slot: "7" })]);
    expect(s.requirements[0]!.projects).toEqual(["a", "b", "c"]);
    expect(s.requirements[0]!.slot).toBe(7);
  });
});

describe("reqAgeSeconds", () => {
  it("computes non-negative age from the bus recv clock", () => {
    const s = foldChain([req("alpha")]);
    const r = s.requirements[0]!;
    expect(reqAgeSeconds(r, r.registeredRecv + 60)).toBe(60);
    expect(reqAgeSeconds(r, r.registeredRecv - 60)).toBe(0);
  });
});
