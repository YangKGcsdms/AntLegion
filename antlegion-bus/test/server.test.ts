import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerV2 } from "../src/server.js";

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-srv-"));
  return createServerV2({ secret: "test", dataDir: dir }).app;
}

const post = (app: ReturnType<typeof freshApp>, body: unknown) =>
  app.request("/facts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("v2 server — wire surface", () => {
  it("health reports protocol 2.0", async () => {
    const res = await freshApp().request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).protocol).toBe("2.0");
  });

  it("POST /facts appends and returns seq/recv/sig (201)", async () => {
    const res = await post(freshApp(), { type: "demo", author: "a", ts: 1, payload: { x: 1 } });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.seq).toBe(1);
    expect(b.recv).toBeGreaterThan(0);
    expect(b.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(b.deduped).toBe(false);
  });

  it("identical re-POST dedups (200), same seq, no second copy", async () => {
    const app = freshApp();
    const body = { type: "demo", author: "a", ts: 1, payload: { x: 1 } };
    const r1 = await (await post(app, body)).json();
    const res2 = await post(app, body);
    expect(res2.status).toBe(200);
    const r2 = await res2.json();
    expect(r2.deduped).toBe(true);
    expect(r2.seq).toBe(r1.seq);
    expect((await (await app.request("/facts/head")).json()).head_seq).toBe(1);
  });

  it("a mismatched client id is rejected 409", async () => {
    const res = await post(freshApp(), { type: "demo", author: "a", ts: 1, id: "deadbeef" });
    expect(res.status).toBe(409);
  });

  it("missing required fields → 400", async () => {
    const res = await post(freshApp(), { type: "demo" });
    expect(res.status).toBe(400);
  });

  it("GET /facts uses since as a cursor and sets X-Max-Seq", async () => {
    const app = freshApp();
    await post(app, { type: "a", author: "x", ts: 1 });
    await post(app, { type: "b", author: "x", ts: 2 });
    const res = await app.request("/facts?since=1");
    expect(res.headers.get("X-Max-Seq")).toBe("2");
    expect((await res.json()).map((f: { type: string }) => f.type)).toEqual(["b"]);
  });

  it("GET /facts filters by type glob, author, and refs.<key>", async () => {
    const app = freshApp();
    await post(app, { type: "build.failed", author: "ci", ts: 1 });
    await post(app, { type: "build.passed", author: "ci", ts: 2 });
    await post(app, { type: "_.claim", author: "w", ts: 3, refs: { claim_of: "F1" }, nonce: "1" });
    expect((await (await app.request("/facts?type=build.*")).json()).length).toBe(2);
    expect((await (await app.request("/facts?author=w")).json()).length).toBe(1);
    expect((await (await app.request("/facts?refs.claim_of=F1")).json()).length).toBe(1);
  });

  it("GET /facts/:id returns the fact or 404", async () => {
    const app = freshApp();
    const r = await (await post(app, { type: "demo", author: "a", ts: 1 })).json();
    expect((await app.request(`/facts/${r.id}`)).status).toBe(200);
    expect((await app.request("/facts/nope")).status).toBe(404);
  });
});
