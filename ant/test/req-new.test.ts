import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppendResult, FactInput } from "@antlegion/bus/types";
import {
  buildDcuManifest, deriveSlug, stampOf, createdOf, findExistingBySlug,
  reqNewFact, createRequirement, REQ_NEW_AUTHOR,
} from "../src/req-new.js";
import { scanWorkspace, backfill, AUTHOR, type Publisher } from "../src/dcus/ingestor-req.js";

const tmps: string[] = [];
async function tmpdir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "ecu-reqnew-"));
  tmps.push(d);
  return d;
}
afterEach(async () => {
  while (tmps.length) await fs.rm(tmps.pop()!, { recursive: true, force: true });
});

const silent = () => {};

/** In-memory publisher that mimics the bus: dedup on canonical content id (sorted keys). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) as string;
}
function fakePublisher() {
  const byId = new Map<string, number>();
  let seq = 0;
  const publisher: Publisher = {
    append: async (input: FactInput) => {
      const id = stable([input.type, input.author, input.ts, input.payload, input.refs ?? null, input.nonce ?? null]);
      const existing = byId.get(id);
      if (existing != null) return { seq: existing, recv: 0, id, sig: "x", deduped: true } satisfies AppendResult;
      byId.set(id, ++seq);
      return { seq, recv: 0, id, sig: "x", deduped: false } satisfies AppendResult;
    },
  };
  return { publisher, size: () => byId.size };
}

describe("deriveSlug", () => {
  it("slugifies ASCII names", () => {
    expect(deriveSlug("Adjudicator Evidence Fold")).toBe("adjudicator-evidence-fold");
    expect(deriveSlug("req: new/cool  thing!")).toBe("req-new-cool-thing");
  });
  it("returns null for non-ASCII names (caller must require -s)", () => {
    expect(deriveSlug("adjudicator证据校验上线")).toBeNull();
    expect(deriveSlug("！！！")).toBeNull();
  });
});

describe("buildDcuManifest", () => {
  it("is minimal: REQ_NAME/CREATED/SLUG/ORIGIN=dcu, no port-slot fields", () => {
    const m = buildDcuManifest({ name: "测试", slug: "test", created: "2026-07-21 09:30" });
    expect(m).toContain("REQ_NAME=测试");
    expect(m).toContain("CREATED=2026-07-21 09:30");
    expect(m).toContain("SLUG=test");
    expect(m).toContain("ORIGIN=dcu");
    expect(m).not.toMatch(/PORT_|SLOT/);
  });
});

describe("stampOf / createdOf", () => {
  it("formats local time", () => {
    const d = new Date(2026, 6, 21, 9, 5); // 2026-07-21 09:05 local
    expect(stampOf(d)).toBe("202607210905");
    expect(createdOf(d)).toBe("2026-07-21 09:05");
  });
});

describe("createRequirement", () => {
  it("creates dir + manifest + docs/ + logs/ and plans the dcu fact", async () => {
    const root = await tmpdir();
    const now = new Date(2026, 6, 21, 9, 5);
    const r = await createRequirement(root, "adjudicator证据校验上线", {
      slug: "adjudicator-evidence-fold", now,
    });
    expect(r.existed).toBe(false);
    expect(r.dirname).toBe("202607210905-adjudicator-evidence-fold");
    expect(r.dir).toBe(path.join(root, r.dirname));

    const manifest = await fs.readFile(path.join(r.dir, "dcu.env"), "utf-8");
    expect(manifest).toBe(buildDcuManifest({
      name: "adjudicator证据校验上线", slug: "adjudicator-evidence-fold", created: "2026-07-21 09:05",
    }));
    await fs.stat(path.join(r.dir, "docs"));
    await fs.stat(path.join(r.dir, "logs"));

    expect(r.fact.type).toBe("req.registered");
    expect(r.fact.nonce).toBe("req:dcu:202607210905-adjudicator-evidence-fold");
    expect(r.fact.author).toBe(AUTHOR); // must match the ingestor for cross-dedup
    expect(r.fact.payload).toMatchObject({
      slug: "adjudicator-evidence-fold", name: "adjudicator证据校验上线",
      created: "2026-07-21 09:05", origin: "dcu", slot: null, projects: [], ports: {},
    });
    expect(r.fact.refs).toEqual({ subject: "adjudicator-evidence-fold" });
    // deterministic ts from CREATED, never wall clock
    const r2 = await createRequirement(await tmpdir(), "adjudicator证据校验上线", {
      slug: "adjudicator-evidence-fold", now,
    });
    expect(r2.fact.ts).toBe(r.fact.ts);
  });

  it("derives the slug from ASCII names without -s", async () => {
    const root = await tmpdir();
    const r = await createRequirement(root, "Board Polish", { now: new Date(2026, 6, 21, 9, 5) });
    expect(r.dirname).toBe("202607210905-board-polish");
  });

  it("rejects non-ASCII names without -s, and invalid slugs", async () => {
    const root = await tmpdir();
    await expect(createRequirement(root, "证据校验")).rejects.toThrow(/-s/);
    await expect(createRequirement(root, "x", { slug: "Bad Slug!" })).rejects.toThrow(/invalid slug/);
  });

  it("re-run with the same slug finds the existing dir (no fork, fact re-planned from manifest)", async () => {
    const root = await tmpdir();
    const first = await createRequirement(root, "证据校验", { slug: "evidence", now: new Date(2026, 6, 21, 9, 5) });
    // a minute later, a different argv name — must still find + reuse
    const second = await createRequirement(root, "证据校验", { slug: "evidence", now: new Date(2026, 6, 21, 9, 6) });
    expect(second.existed).toBe(true);
    expect(second.dirname).toBe(first.dirname);
    expect(second.fact).toEqual(first.fact); // identical content id → bus dedups
    // and the manifest was not overwritten
    const manifest = await fs.readFile(path.join(first.dir, "dcu.env"), "utf-8");
    expect(manifest).toContain("REQ_NAME=证据校验");
    expect(await findExistingBySlug(root, "evidence")).toBe(first.dirname);
    expect(await findExistingBySlug(root, "nope")).toBeNull();
  });
});

describe("req new ⇄ ingestor cross-dedup (origin dcu)", () => {
  it("the ingestor plans a byte-identical req.registered for a req-new dir", async () => {
    const root = await tmpdir();
    const r = await createRequirement(root, "adjudicator证据校验上线", {
      slug: "adjudicator-evidence-fold", now: new Date(2026, 6, 21, 9, 5),
    });
    const scan = await scanWorkspace(root, "dcu");
    const planned = scan.facts.find((f) => f.input.type === "req.registered")!;
    expect(planned.input).toEqual(r.fact); // same author/ts/payload/refs/nonce
  });

  it("publish via req new then ingestor backfill: second publish dedups", async () => {
    const root = await tmpdir();
    const r = await createRequirement(root, "证据校验", { slug: "evidence", now: new Date(2026, 6, 21, 9, 5) });
    const { publisher, size } = fakePublisher();
    const first = await publisher.append(r.fact);
    expect(first.deduped).toBe(false);
    const stats = await backfill(root, publisher, silent, undefined, "dcu");
    expect(stats.reqsPublished).toBe(0);
    expect(stats.reqsDeduped).toBe(1);
    expect(size()).toBe(1);
  });

  it("dcu scan reads dcu.env, tags origin, parses 状态 headers on docs", async () => {
    const root = await tmpdir();
    const r = await createRequirement(root, "证据校验", { slug: "evidence", now: new Date(2026, 6, 21, 9, 5) });
    await fs.writeFile(path.join(r.dir, "docs", "方案.md"), "# 方案\n\n状态：方案待评审（未开工）\n", "utf-8");
    const scan = await scanWorkspace(root, "dcu");
    expect(scan.errors).toEqual([]);
    const doc = scan.facts.find((f) => f.input.type === "doc.updated")!;
    expect(doc.input.payload).toMatchObject({
      reqSlug: "evidence", doc: "方案.md", status: "方案待评审（未开工）", origin: "dcu",
    });
  });
});
