import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import { ClientV2, localTransport } from "../src/client.js";
import { dispatch } from "../src/mcp.js";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-mcp-"));
  const bus = new BusV2({ secret: "mcp", dataDir: dir });
  const t = localTransport(bus);
  return { bus, t, client: (n: string) => new ClientV2(t, n) };
}

describe("v2 MCP adapter — tool dispatch over the folding SDK", () => {
  it("publish → claim → state → resolve → state", async () => {
    const { client } = rig();
    const c = client("agent");

    const pub = (await dispatch(c, "antlegion_publish", { fact_type: "task.x", payload: { a: 1 } })) as { fact_id: string };
    expect(pub.fact_id).toMatch(/^[0-9a-f]{64}$/);

    expect(await dispatch(c, "antlegion_claim", { fact_id: pub.fact_id })).toMatchObject({ won: true });
    expect(await dispatch(c, "antlegion_state", { fact_id: pub.fact_id })).toEqual({ state: "claimed", owner: "agent" });

    await dispatch(c, "antlegion_resolve", { fact_id: pub.fact_id, result_facts: [{ fact_type: "task.done", payload: {} }] });
    expect(await dispatch(c, "antlegion_state", { fact_id: pub.fact_id })).toEqual({ state: "resolved", owner: "agent" });
  });

  it("query returns facts with a next_cursor", async () => {
    const { client } = rig();
    const c = client("agent");
    await dispatch(c, "antlegion_publish", { fact_type: "ev.a", payload: {} });
    await dispatch(c, "antlegion_publish", { fact_type: "ev.b", payload: {} });
    const q = (await dispatch(c, "antlegion_query", { fact_type: "ev.*" })) as { count: number; next_cursor: number };
    expect(q.count).toBe(2);
    expect(q.next_cursor).toBeGreaterThan(0);
  });

  it("causation links a child to its parent", async () => {
    const { client } = rig();
    const c = client("agent");
    const root = (await dispatch(c, "antlegion_publish", { fact_type: "root", payload: {} })) as { fact_id: string };
    const child = (await dispatch(c, "antlegion_publish", { fact_type: "child", payload: {}, parent_fact_id: root.fact_id })) as { fact_id: string };
    const chain = (await dispatch(c, "antlegion_causation", { fact_id: child.fact_id })) as { chain_length: number };
    expect(chain.chain_length).toBe(2);
  });

  it("two observers corroborating reach consensus", async () => {
    const { client } = rig();
    const author = client("author");
    const pub = (await dispatch(author, "antlegion_publish", { fact_type: "obs", payload: {} })) as { fact_id: string };
    await dispatch(client("r1"), "antlegion_observe", { fact_id: pub.fact_id, verdict: "corroborate" });
    await dispatch(client("r2"), "antlegion_observe", { fact_id: pub.fact_id, verdict: "corroborate" });
    expect(await client("probe").trustOf(pub.fact_id)).toBe("consensus");
  });

  it("a losing claimant is told it did not win", async () => {
    const { client } = rig();
    const a = client("alice");
    const b = client("bob");
    const pub = (await dispatch(a, "antlegion_publish", { fact_type: "task", payload: {} })) as { fact_id: string };
    await dispatch(a, "antlegion_claim", { fact_id: pub.fact_id });
    expect(await dispatch(b, "antlegion_claim", { fact_id: pub.fact_id })).toMatchObject({ won: false, winner: "alice" });
  });
});
