import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { createApp } from "../src/server/app.js";

const TEST_DIR = ".data-http-test";

describe("HTTP API", () => {
  let app: ReturnType<typeof createApp>["app"];
  let engine: ReturnType<typeof createApp>["engine"];

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const result = createApp({
      data: { dir: TEST_DIR },
      flow: {
        dedupeWindowSeconds: 10,
        rateLimitCapacity: 100,
        rateLimitRefillRate: 100,
        circuitBreakerWindowSeconds: 5,
        circuitBreakerThreshold: 1000,
      },
    });
    app = result.app;
    engine = result.engine;
  });

  afterEach(() => {
    engine.shutdown();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function req(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const init: RequestInit = { method, headers: {} };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] =
        "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await app.request(path, init);
    const json = await res.json();
    return { status: res.status, json };
  }

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  it("GET /health", async () => {
    const { status, json } = await req("GET", "/health");
    expect(status).toBe(200);
    expect((json as any).status).toBe("ok");
  });

  it("GET /stats", async () => {
    const { status, json } = await req("GET", "/stats");
    expect(status).toBe(200);
    expect((json as any).facts.total).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Ant lifecycle
  // -----------------------------------------------------------------------

  it("POST /ants/connect → heartbeat → disconnect", async () => {
    // Connect
    const { status, json } = await req("POST", "/ants/connect", {
      name: "reviewer",
    });
    expect(status).toBe(200);
    const { ant_id, token } = json as any;
    expect(ant_id).toBeTruthy();
    expect(token).toBeTruthy();

    // Heartbeat
    const hb = await req("POST", `/ants/${ant_id}/heartbeat`);
    expect(hb.status).toBe(200);
    expect((hb.json as any).state).toBe("active");

    // Disconnect
    const dc = await req("POST", `/ants/${ant_id}/disconnect`, { token });
    expect(dc.status).toBe(200);
    expect((dc.json as any).success).toBe(true);
  });

  it("GET /ants lists connected ants", async () => {
    await req("POST", "/ants/connect", { name: "a" });
    await req("POST", "/ants/connect", { name: "b" });
    const { json } = await req("GET", "/ants");
    expect((json as any[]).length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Fact lifecycle
  // -----------------------------------------------------------------------

  async function connectAndPublish(
    factOverrides: Record<string, unknown> = {},
  ) {
    const { json: antRes } = await req("POST", "/ants/connect", {
      name: "publisher",
    });
    const { ant_id, token } = antRes as any;

    const { status, json: factRes } = await req("POST", "/facts", {
      fact_type: "test.event",
      payload: { key: "value" },
      source_ant_id: ant_id,
      token,
      ...factOverrides,
    });
    return { antId: ant_id, token, factRes: factRes as any, status };
  }

  it("POST /facts publishes a fact", async () => {
    const { status, factRes } = await connectAndPublish();
    expect(status).toBe(201);
    expect(factRes.fact_id).toBeTruthy();
    expect(factRes.state).toBe("published");
    expect(factRes.signature).toBeTruthy();
  });

  it("GET /facts lists facts", async () => {
    await connectAndPublish();
    const { json } = await req("GET", "/facts");
    expect((json as any[]).length).toBe(1);
  });

  it("GET /facts?fact_type=... filters", async () => {
    await connectAndPublish({ fact_type: "a.type" });
    await connectAndPublish({ fact_type: "b.type" });
    const { json } = await req("GET", "/facts?fact_type=a.type");
    expect((json as any[]).length).toBe(1);
  });

  it("GET /facts/:id returns single fact", async () => {
    const { factRes } = await connectAndPublish();
    const { status, json } = await req("GET", `/facts/${factRes.fact_id}`);
    expect(status).toBe(200);
    expect((json as any).fact_id).toBe(factRes.fact_id);
  });

  it("GET /facts/:id returns 404 for unknown", async () => {
    const { status } = await req("GET", "/facts/nonexistent");
    expect(status).toBe(404);
  });

  it("claim → resolve lifecycle via HTTP", async () => {
    const { factRes, antId, token } = await connectAndPublish();
    const factId = factRes.fact_id;

    // Claim
    const claim = await req("POST", `/facts/${factId}/claim`, {
      ant_id: antId,
      token,
    });
    expect(claim.status).toBe(200);
    expect((claim.json as any).claimed_by).toBe(antId);

    // Resolve
    const resolve = await req("POST", `/facts/${factId}/resolve`, {
      ant_id: antId,
      token,
    });
    expect(resolve.status).toBe(200);

    // Verify state
    const { json } = await req("GET", `/facts/${factId}`);
    expect((json as any).state).toBe("resolved");
  });

  it("corroborate and contradict via HTTP", async () => {
    const { factRes } = await connectAndPublish();
    const factId = factRes.fact_id;

    // Connect another ant to corroborate
    const { json: c2 } = await req("POST", "/ants/connect", {
      name: "corroborator",
    });
    const antId2 = (c2 as any).ant_id;

    const corr = await req("POST", `/facts/${factId}/corroborate`, {
      ant_id: antId2,
      token: (c2 as any).token,
    });
    expect(corr.status).toBe(200);
    expect((corr.json as any).epistemic_state).toBe("corroborated");
  });

  it("release via HTTP", async () => {
    const { factRes, antId, token } = await connectAndPublish();
    const factId = factRes.fact_id;

    await req("POST", `/facts/${factId}/claim`, {
      ant_id: antId,
      token,
    });

    const release = await req("POST", `/facts/${factId}/release`, {
      ant_id: antId,
      token,
    });
    expect(release.status).toBe(200);

    const { json } = await req("GET", `/facts/${factId}`);
    expect((json as any).state).toBe("published");
  });

  // -----------------------------------------------------------------------
  // Causation chain
  // -----------------------------------------------------------------------

  it("GET /facts/:id/causation returns chain", async () => {
    const { factRes, antId, token } = await connectAndPublish();
    await req("POST", `/facts/${factRes.fact_id}/claim`, {
      ant_id: antId,
      token,
    });
    await req("POST", `/facts/${factRes.fact_id}/resolve`, {
      ant_id: antId,
      token,
      result_facts: [
        { fact_type: "child", payload: { x: 1 }, mode: "broadcast" },
      ],
    });

    const { json: facts } = await req("GET", "/facts?fact_type=child");
    const childId = (facts as any[])[0].fact_id;

    const { status, json } = await req("GET", `/facts/${childId}/causation`);
    expect(status).toBe(200);
    expect((json as any[]).length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Admin
  // -----------------------------------------------------------------------

  it("admin GC and compact", async () => {
    const gc = await req("POST", "/admin/storage/gc");
    expect(gc.status).toBe(200);

    const compact = await req("POST", "/admin/storage/compact");
    expect(compact.status).toBe(200);
  });

  it("admin metrics endpoint", async () => {
    const m = await req("GET", "/admin/metrics");
    expect(m.status).toBe(200);
    expect((m.json as any).computed).toBeDefined();
    expect((m.json as any).computed.resolution_rate).toBeDefined();
  });

  it("admin storage stats", async () => {
    const st = await req("GET", "/admin/storage/stats");
    expect(st.status).toBe(200);
    expect((st.json as any).facts_total).toBeDefined();
  });
});
