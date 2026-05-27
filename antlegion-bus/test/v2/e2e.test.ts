import { describe, it, expect, afterEach } from "vitest";
import { serve } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerV2 } from "../../src/v2/server.js";
import { ClientV2, httpTransport } from "../../src/v2/client.js";

let running: { close: () => void } | null = null;
afterEach(() => { running?.close(); running = null; });

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-e2e-"));
  const { app } = createServerV2({ secret: "e2e", dataDir: dir });
  const port = await new Promise<number>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
    running = s as unknown as { close: () => void };
  });
  return `http://localhost:${port}`;
}

describe("v2 end-to-end: two heterogeneous clients coordinate over real HTTP", () => {
  it("exactly one claims the task, resolves it, and both observe the outcome", async () => {
    const base = await startServer();
    const alice = new ClientV2(httpTransport(base), "alice");   // e.g. Claude Code
    const bob = new ClientV2(httpTransport(base), "bob");       // e.g. a cron script

    // alice publishes an exclusive unit of work
    const { id } = await alice.publish("task.build", { target: "todo-app" });

    // both race to claim it
    const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]);
    expect([ra.won, rb.won].filter(Boolean)).toHaveLength(1); // exactly-once
    expect(ra.winner).toBe(rb.winner);

    // the winner does the work and resolves with a result fact
    const winner = ra.won ? alice : bob;
    const { childIds } = await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);

    // both clients, independently, observe the same resolved state
    expect((await alice.state(id)).state).toBe("resolved");
    expect((await bob.state(id)).state).toBe("resolved");

    // and the result fact is on the causation chain of the task
    const chain = await bob.causation(childIds[0]);
    expect(chain.map((f) => f.id)).toEqual([id, childIds[0]]);
  });

  it("5-way concurrent contention: exactly one winner everyone agrees on, incl. a fresh joiner", async () => {
    const base = await startServer();
    const setup = new ClientV2(httpTransport(base), "setup");
    const { id } = await setup.publish("task.contended", {});

    const clients = ["c1", "c2", "c3", "c4", "c5"].map((n) => new ClientV2(httpTransport(base), n));
    const results = await Promise.all(clients.map((c) => c.claim(id)));

    expect(results.filter((r) => r.won)).toHaveLength(1);          // exactly one winner
    expect(new Set(results.map((r) => r.winner)).size).toBe(1);     // all five agree

    // a brand-new client that never participated reconstructs the same state from the log alone
    const fresh = new ClientV2(httpTransport(base), "observer");
    const st = await fresh.state(id);
    expect(st.state).toBe("claimed");
    expect(st.owner).toBe(results[0].winner);
  });

  it("a published observation can be corroborated to consensus over HTTP", async () => {
    const base = await startServer();
    const author = new ClientV2(httpTransport(base), "author");
    const r1 = new ClientV2(httpTransport(base), "r1");
    const r2 = new ClientV2(httpTransport(base), "r2");
    const { id } = await author.publish("obs.metric", { cpu: 0.9 });
    await r1.observe(id, "corroborate");
    await r2.observe(id, "corroborate");
    expect(await author.trustOf(id)).toBe("consensus");
  });
});
