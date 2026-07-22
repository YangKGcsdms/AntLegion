import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import { ClientV2, defaultAuthor, httpTransport, localTransport } from "../src/client.js";

function sharedBus() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-cli-"));
  return new BusV2({ secret: "test", dataDir: dir });
}

describe("v2 client SDK — the elegant surface over the fold", () => {
  it("defaultAuthor is a stable <user>@<hostname> identity (no pid)", () => {
    expect(defaultAuthor()).toBe(`${userInfo().username}@${hostname()}`);
    expect(defaultAuthor()).not.toContain(String(process.pid));
  });

  it("an unreachable bus produces a human-grade connection error", async () => {
    const c = new ClientV2(httpTransport("http://localhost:1"), "alice");
    await expect(c.publish("x", {})).rejects.toThrow(
      "cannot reach bus at http://localhost:1 — start one with: npm run dev",
    );
  });

  it("publish then query round-trips a fact", async () => {
    const c = new ClientV2(localTransport(sharedBus()), "alice");
    const { id } = await c.publish("note", { msg: "hi" });
    const facts = await c.query({ type: "note" });
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe(id);
  });

  it("a single claim wins and the fact reads as claimed", async () => {
    const c = new ClientV2(localTransport(sharedBus()), "alice");
    const { id } = await c.publish("task", { do: "x" });
    const res = await c.claim(id);
    expect(res.won).toBe(true);
    expect(await c.state(id)).toEqual({ state: "claimed", owner: "alice" });
  });

  it("two clients contending for one fact: exactly one wins, both agree", async () => {
    const bus = sharedBus();
    const a = new ClientV2(localTransport(bus), "alice");
    const b = new ClientV2(localTransport(bus), "bob");
    const { id } = await a.publish("task", { do: "x" });

    const [ra, rb] = await Promise.all([a.claim(id), b.claim(id)]);
    expect([ra.won, rb.won].filter(Boolean)).toHaveLength(1); // exactly one
    expect(ra.winner).toBe(rb.winner);                        // agree on winner

    const loser = ra.won ? b : a;
    const winner = ra.winner!;
    expect(await loser.state(id)).toEqual({ state: "claimed", owner: winner });
  });

  it("resolve by the winner makes it resolved and emits a child on the causation chain", async () => {
    const c = new ClientV2(localTransport(sharedBus()), "alice");
    const { id } = await c.publish("task", { do: "x" });
    await c.claim(id);
    const { childIds } = await c.resolve(id, [{ type: "result", payload: { ok: true } }]);
    expect(await c.state(id)).toEqual({ state: "resolved", owner: "alice" });
    const chain = await c.causation(childIds[0]);
    expect(chain.map((f) => f.id)).toEqual([id, childIds[0]]); // task → result
  });

  it("a non-winner's resolve throws and the fact stays claimed by the winner", async () => {
    const bus = sharedBus();
    const a = new ClientV2(localTransport(bus), "alice");
    const b = new ClientV2(localTransport(bus), "bob");
    const { id } = await a.publish("task", {});
    await a.claim(id);            // alice wins (lower seq)
    await expect(b.resolve(id)).rejects.toThrow(
      `resolve ignored — fact ${id} is owned by 'alice' (you are 'bob')`,
    );
    expect(await a.state(id)).toEqual({ state: "claimed", owner: "alice" });
  });

  it("resolve without any active claim throws", async () => {
    const c = new ClientV2(localTransport(sharedBus()), "alice");
    const { id } = await c.publish("task", {});
    await expect(c.resolve(id)).rejects.toThrow(
      `resolve ignored — fact ${id} has no active claim (you are 'alice')`,
    );
  });

  it("resolving an already-resolved fact throws instead of a silent no-op", async () => {
    const c = new ClientV2(localTransport(sharedBus()), "alice");
    const { id } = await c.publish("task", {});
    await c.claim(id);
    await c.resolve(id);
    await expect(c.resolve(id)).rejects.toThrow(`resolve ignored — fact ${id} is already resolved`);
  });

  it("claim/resolve/release on a nonexistent fact throw 'not found'", async () => {
    const c = new ClientV2(localTransport(sharedBus()), "alice");
    const missing = "0".repeat(64);
    await expect(c.claim(missing)).rejects.toThrow(`fact ${missing} not found`);
    await expect(c.resolve(missing)).rejects.toThrow(`fact ${missing} not found`);
    await expect(c.release(missing)).rejects.toThrow(`fact ${missing} not found`);
  });

  it("release by a non-owner throws; the owner's release reopens the fact", async () => {
    const bus = sharedBus();
    const a = new ClientV2(localTransport(bus), "alice");
    const b = new ClientV2(localTransport(bus), "bob");
    const { id } = await a.publish("task", {});
    await a.claim(id);
    await expect(b.release(id)).rejects.toThrow(
      `release ignored — fact ${id} is owned by 'alice' (you are 'bob')`,
    );
    await a.release(id);
    expect(await a.state(id)).toEqual({ state: "open", owner: null });
  });

  it("two distinct corroborations reach consensus", async () => {
    const bus = sharedBus();
    const author = new ClientV2(localTransport(bus), "author");
    const v1 = new ClientV2(localTransport(bus), "v1");
    const v2 = new ClientV2(localTransport(bus), "v2");
    const { id } = await author.publish("claim.fact", { x: 1 });
    await v1.observe(id, "corroborate");
    await v2.observe(id, "corroborate");
    expect(await author.trustOf(id)).toBe("consensus");
  });

  it("release lets another client take over", async () => {
    const bus = sharedBus();
    const a = new ClientV2(localTransport(bus), "alice");
    const b = new ClientV2(localTransport(bus), "bob");
    const { id } = await a.publish("task", {});
    await a.claim(id);
    await a.release(id);
    const r = await b.claim(id);
    expect(r.won).toBe(true);
    expect(await b.state(id)).toEqual({ state: "claimed", owner: "bob" });
  });
});
