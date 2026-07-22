import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppendResult, FactInput } from "antlegion-bus/types";
import {
  scanWorkspace, backfill, reqPayloadFromEnv, reqFactTs, newKnownState,
  parseReqDirName, stampToUnix, createdToUnix,
  type Publisher,
} from "../src/dcus/ingestor-req.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/req-workspace");

/** In-memory publisher that mimics the bus: id = content address (ts included). */
function fakePublisher() {
  const byId = new Map<string, number>();
  const appends: FactInput[] = [];
  let seq = 0;
  const key = (i: FactInput) =>
    JSON.stringify(i, Object.keys(i).concat(["payload", "refs"]).sort());
  const publisher: Publisher = {
    append: async (input) => {
      appends.push(input);
      const id = JSON.stringify([input.type, input.author, input.ts, input.payload, input.refs ?? null, input.nonce ?? null]);
      const existing = byId.get(id);
      if (existing != null) {
        return { seq: existing, recv: 0, id, sig: "x", deduped: true } satisfies AppendResult;
      }
      byId.set(id, ++seq);
      return { seq, recv: 0, id, sig: "x", deduped: false } satisfies AppendResult;
    },
  };
  void key;
  return { publisher, appends, size: () => byId.size };
}

const silent = () => {};

describe("parseReqDirName / stamp helpers", () => {
  it("parses <yyyymmddHHMM>-<名称> including names with dashes", () => {
    expect(parseReqDirName("202607161927-薪资巡检-出差补贴配置巡检")).toEqual({
      stamp: "202607161927", title: "薪资巡检-出差补贴配置巡检",
    });
    expect(parseReqDirName("README.md")).toBeNull();
    expect(parseReqDirName("scratch-notes")).toBeNull();
  });
  it("converts stamps and CREATED strings to unix seconds", () => {
    expect(stampToUnix("202607201813")).toBe(createdToUnix("2026-07-20 18:13"));
    expect(stampToUnix("garbage")).toBeNull();
    expect(createdToUnix("not a date")).toBeNull();
  });
});

describe("reqPayloadFromEnv / reqFactTs", () => {
  it("maps the oaws.env schema onto the payload", () => {
    const p = reqPayloadFromEnv("202607010900-测试需求甲", {
      REQ_NAME: "测试需求甲", CREATED: "2026-07-01 09:00", SLUG: "test-req-alpha",
      SLOT: "0", BRANCH: "feature/test-req-alpha", BASE_BRANCH: "master",
      PROJECTS: "workflow-oa workflow",
      PORT_BACKEND: "21001", PORT_WORKFLOW: "21002", PORT_UI: "21003",
      PORT_LLM: "21004", PORT_DEBUG: "21005",
    });
    expect(p).toEqual({
      slug: "test-req-alpha", name: "测试需求甲", created: "2026-07-01 09:00",
      origin: "oa",
      slot: 0, branch: "feature/test-req-alpha", baseBranch: "master",
      projects: ["workflow-oa", "workflow"],
      ports: { backend: 21001, workflow: 21002, ui: 21003, llm: 21004, debug: 21005 },
    });
  });
  it("falls back to dirname when oaws.env is missing fields", () => {
    const p = reqPayloadFromEnv("202607010900-测试需求甲", {});
    expect(p.slug).toBe("202607010900-测试需求甲");
    expect(p.name).toBe("测试需求甲");
    expect(p.created).toBe("2026-07-01 09:00");
    expect(p.slot).toBeNull();
    expect(p.ports).toEqual({});
  });
  it("derives a deterministic fact ts from CREATED, then dirname, then 0", () => {
    expect(reqFactTs("x", { CREATED: "2026-07-01 09:00" })).toBe(createdToUnix("2026-07-01 09:00"));
    expect(reqFactTs("202607010900-测试需求甲", {})).toBe(stampToUnix("202607010900"));
    expect(reqFactTs("garbage", {})).toBe(0);
  });
});

describe("scanWorkspace (fixtures)", () => {
  it("plans one req.registered per requirement dir, ignoring non-matching entries", async () => {
    const scan = await scanWorkspace(FIXTURES);
    const reqs = scan.facts.filter((f) => f.input.type === "req.registered");
    expect(reqs.map((f) => f.input.nonce).sort()).toEqual([
      "req:oa:202607010900-测试需求甲",
      "req:oa:202607021030-测试需求乙",
      "req:oa:202607031100-测试需求丙",
    ]);
    const alpha = reqs.find((f) => f.label.includes("甲"))!;
    expect(alpha.input.payload).toMatchObject({
      slug: "test-req-alpha", name: "测试需求甲", slot: 0,
      branch: "feature/test-req-alpha", projects: ["workflow-oa", "workflow"],
      ports: { backend: 21001, workflow: 21002, ui: 21003, llm: 21004, debug: 21005 },
    });
    expect(alpha.input.author).toBe("ingestor-req@ecu");
    expect(alpha.input.refs).toEqual({ subject: "test-req-alpha" });
    // deterministic ts: CREATED, not wall clock
    expect(alpha.input.ts).toBe(createdToUnix("2026-07-01 09:00"));
  });

  it("plans doc.updated per docs/*.md with parsed 状态 headers and mtime nonces", async () => {
    const scan = await scanWorkspace(FIXTURES);
    const docs = scan.facts.filter((f) => f.input.type === "doc.updated");
    expect(docs).toHaveLength(3);
    const byLabel = new Map(docs.map((f) => [f.label, f]));
    const plan = byLabel.get("202607010900-测试需求甲/docs/方案.md")!;
    expect(plan.input.payload).toMatchObject({
      reqSlug: "test-req-alpha", doc: "方案.md",
      status: "开发中（后端已完成，前端联调中）",
      path: "202607010900-测试需求甲/docs/方案.md",
    });
    const mtime = (plan.input.payload as { mtime: number }).mtime;
    expect(plan.input.nonce).toBe(`doc:202607010900-测试需求甲/docs/方案.md:${mtime}`);
    expect(plan.input.ts).toBe(mtime / 1000);
    expect(plan.input.refs).toEqual({ subject: "test-req-alpha/方案.md" });
    // no status header → null
    expect(byLabel.get("202607010900-测试需求甲/docs/单元测试报告.md")!.input.payload)
      .toMatchObject({ status: null });
    // half-width colon
    expect(byLabel.get("202607021030-测试需求乙/docs/设计.md")!.input.payload)
      .toMatchObject({ status: "方案待评审" });
    // req with no docs dir contributes zero doc facts, zero errors
    expect(docs.some((f) => f.label.includes("丙"))).toBe(false);
    expect(scan.errors).toEqual([]);
  });

  it("never throws on a missing root — reports errors instead", async () => {
    const scan = await scanWorkspace(path.join(FIXTURES, "does-not-exist"));
    expect(scan.facts).toEqual([]);
    expect(scan.errors.length).toBeGreaterThan(0);
  });
});

describe("backfill (fixtures, fake bus)", () => {
  it("publishes everything on cold start, dedups on rerun", async () => {
    const { publisher, size } = fakePublisher();
    const s1 = await backfill(FIXTURES, publisher, silent);
    expect(s1).toMatchObject({
      reqsPublished: 3, reqsDeduped: 0, docsPublished: 3, docsDeduped: 0, errors: 0,
    });
    expect(size()).toBe(6);

    const s2 = await backfill(FIXTURES, publisher, silent);
    expect(s2).toMatchObject({
      reqsPublished: 0, reqsDeduped: 3, docsPublished: 0, docsDeduped: 3, errors: 0,
    });
    expect(size()).toBe(6); // fact count unchanged
  });

  it("republishes a doc when its mtime changes (new nonce → new fact)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ecu-ingest-"));
    try {
      await fs.cp(FIXTURES, tmp, { recursive: true });
      const { publisher, size } = fakePublisher();
      await backfill(tmp, publisher, silent);
      const target = path.join(tmp, "202607010900-测试需求甲/docs/方案.md");
      await fs.appendFile(target, "\n补充一行，改变 mtime。\n");
      // mtime granularity: force a distinct mtimeMs
      const now = new Date();
      await fs.utimes(target, now, now);

      const s2 = await backfill(tmp, publisher, silent);
      expect(s2.reqsDeduped).toBe(3);
      expect(s2.docsDeduped).toBe(2);
      expect(s2.docsPublished).toBe(1); // only the edited doc
      expect(size()).toBe(7);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("steady-state skip: known state is not republished over the wire", async () => {
    const { publisher, appends } = fakePublisher();
    const known = newKnownState();
    await backfill(FIXTURES, publisher, silent, known);
    expect(known.docs.size).toBe(3);
    expect(known.reqs.size).toBe(3);
    const before = appends.length;
    const s2 = await backfill(FIXTURES, publisher, silent, known);
    expect(s2.reqsPublished + s2.reqsDeduped).toBe(0); // reqs skipped locally
    expect(s2.docsPublished + s2.docsDeduped).toBe(0); // docs skipped locally
    expect(appends.length - before).toBe(0); // nothing hit the bus
  });
});
