import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import { ClientV2, httpTransport, localTransport } from "../src/client.js";
import type { Fact } from "../src/types.js";

const resources: { bus: BusV2; dir: string }[] = [];
function sharedBus(): BusV2 {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-client-integrity-"));
  const bus = new BusV2({ secret: "test", dataDir: dir, fsync: "no" });
  resources.push({ bus, dir });
  return bus;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const { bus, dir } of resources.splice(0)) {
    bus.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("client completion records", () => {
  it("stores outputs before completion, links their ids, and fixes their parent", async () => {
    const bus = sharedBus();
    const client = new ClientV2(localTransport(bus), "alice");
    const { id } = await client.publish("task");
    await client.claim(id);
    const { childIds } = await client.resolve(id, [
      { type: "result.one", payload: { ok: true }, refs: { parent: "wrong-parent", subject: "result" } },
      { type: "result.two", payload: { ok: true } },
    ]);
    const completion = bus.read({ type: "_.resolve" })[0];
    expect(completion.payload).toEqual({ output_ids: childIds });
    expect(childIds).toHaveLength(2);
    for (const childId of childIds) {
      const output = bus.get(childId)!;
      expect(output.seq).toBeLessThan(completion.seq);
      expect(output.refs.parent).toBe(id);
    }
    expect(bus.get(childIds[0])!.refs.subject).toBe("result");
    expect(await client.state(id)).toEqual({ state: "resolved", owner: "alice" });
  });

  it("leaves saved outputs but no completion when a later output append fails", async () => {
    const bus = sharedBus();
    const transport = localTransport(bus);
    const client = new ClientV2({
      ...transport,
      append: async (input) => {
        if (input.type === "result.failed") throw new Error("output write failed");
        return transport.append(input);
      },
    }, "alice");
    const { id } = await client.publish("task");
    await client.claim(id);
    await expect(client.resolve(id, [
      { type: "result.saved" }, { type: "result.failed" },
    ])).rejects.toThrow("output write failed");
    expect(bus.read({ type: "result.saved" })).toHaveLength(1);
    expect(bus.read({ type: "_.resolve" })).toHaveLength(0);
    expect(await client.state(id)).toEqual({ state: "claimed", owner: "alice" });
  });

  it("rejects an invalid output before writing even an earlier valid output", async () => {
    const bus = sharedBus();
    const client = new ClientV2(localTransport(bus), "alice");
    const { id } = await client.publish("task");
    await client.claim(id);
    const head = bus.headSeq();
    await expect(client.resolve(id, [
      { type: "result.valid" },
      { type: "result.invalid", payload: null as unknown as Record<string, unknown> },
    ])).rejects.toThrow();
    expect(bus.headSeq()).toBe(head);
  });

  it("rechecks ownership after outputs and does not complete a claim that was lost", async () => {
    const bus = sharedBus();
    const transport = localTransport(bus);
    const client = new ClientV2({
      ...transport,
      append: async (input) => {
        const result = await transport.append(input);
        if (input.type === "result") {
          await transport.append({ type: "_.release", author: "alice", ts: 0, refs: { release_of: input.refs!.parent } });
          await transport.append({ type: "_.claim", author: "bob", ts: 0, refs: { claim_of: input.refs!.parent } });
        }
        return result;
      },
    }, "alice");
    const { id } = await client.publish("task");
    await client.claim(id);
    await expect(client.resolve(id, [{ type: "result" }])).rejects.toThrow("owned by 'bob'");
    expect(bus.read({ type: "_.resolve" })).toHaveLength(0);
    expect(await client.state(id)).toEqual({ state: "claimed", owner: "bob" });
  });

  it("reports an unconfirmed completion when ownership changes during its append", async () => {
    const bus = sharedBus();
    const transport = localTransport(bus);
    const client = new ClientV2({
      ...transport,
      append: async (input) => {
        if (input.type === "_.resolve") {
          await transport.append({ type: "_.release", author: "alice", ts: 0, refs: { release_of: input.refs!.resolves } });
          await transport.append({ type: "_.claim", author: "bob", ts: 0, refs: { claim_of: input.refs!.resolves } });
        }
        return transport.append(input);
      },
    }, "alice");
    const { id } = await client.publish("task");
    await client.claim(id);
    await expect(client.resolve(id)).rejects.toThrow("resolve not confirmed");
    // The losing event remains in the immutable log, but it is not completion.
    expect(bus.read({ type: "_.resolve" })).toHaveLength(1);
    expect(await client.state(id)).toEqual({ state: "claimed", owner: "bob" });
  });

  it("records an empty output list when completing without outputs", async () => {
    const bus = sharedBus();
    const client = new ClientV2(localTransport(bus), "alice");
    const { id } = await client.publish("task");
    await client.claim(id);
    expect(await client.resolve(id)).toEqual({ childIds: [] });
    expect(bus.read({ type: "_.resolve" })[0].payload).toEqual({ output_ids: [] });
  });
});

describe("client snapshots", () => {
  it("returns detached facts from registers, causal views, registry and context gaps", async () => {
    const bus = sharedBus();
    const client = new ClientV2(localTransport(bus), "alice");
    const { id } = await client.publish("note", { nested: { value: 1 } }, { refs: { subject: "note" } });
    const child = await client.publish("result", { nested: { value: 2 } }, { refs: { parent: id } });
    await client.publish("sys.registry", { interests: ["note"], publishes: ["result"] });
    const request = await client.publish("context.requested", { question: "why?" }, { refs: { about: id } });
    await client.publish("context.provided", { answer: "because" }, { refs: { answers: request.id } });
    const current = (await client.currentOf("note"))!;
    const history = await client.historyOf("note");
    const chain = await client.causation(child.id);
    const descendants = await client.descendants(id);
    const registry = await client.colony();
    const gaps = await client.contextGaps(true);
    const exposed: Fact[] = [current, ...history, ...chain, ...descendants,
      registry[0].fact, gaps[0].request, ...gaps[0].answers];
    for (const fact of exposed) {
      fact.type = "changed";
      fact.payload.changed = true;
      fact.refs.subject = "changed";
    }
    registry[0].interests.push("changed");
    expect((await client.currentOf("note"))!.payload).toEqual({ nested: { value: 1 } });
    expect((await client.historyOf("note"))[0].type).toBe("note");
    expect((await client.causation(child.id)).map((fact) => fact.type)).toEqual(["note", "result"]);
    expect((await client.descendants(id))[0].type).toBe("result");
    expect((await client.colony())[0].interests).toEqual(["note"]);
    const freshGaps = await client.contextGaps(true);
    expect(freshGaps[0].question).toBe("why?");
    expect(freshGaps[0].answers[0].payload).toEqual({ answer: "because" });
  });

  it("returns detached query results through the built-in transport", async () => {
    const bus = sharedBus();
    bus.append({ type: "note", author: "alice", ts: 0, payload: { nested: { value: 1 } } });
    const client = new ClientV2(localTransport(bus));
    const result = await client.query();
    (result[0].payload.nested as { value: number }).value = 99;
    result.pop();
    expect((await client.query())[0].payload).toEqual({ nested: { value: 1 } });
  });
});

describe("HTTP input validation", () => {
  it.each([
    ["NaN", NaN], ["Infinity", Infinity], ["BigInt", 1n],
    ["function", () => {}], ["Date", new Date(0)],
  ])("rejects %s before sending a request", async (_name, value) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(httpTransport("http://example.invalid").append({
      type: "note", author: "alice", ts: 0, payload: { value },
    })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects circular payloads before sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    await expect(httpTransport("http://example.invalid").append({
      type: "note", author: "alice", ts: 0, payload,
    })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
