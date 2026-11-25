import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import { createServerV2 } from "../src/server.js";
import { computeId } from "../src/hash.js";
import { JsonlLog } from "../src/log.js";
import { current, history, lifecycle, trust } from "../src/fold.js";
import { FactInputError, type FactInput } from "../src/types.js";

const dirs: string[] = [];
const buses: BusV2[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-event-integrity-"));
  dirs.push(dir);
  return dir;
}
function open(dir = directory()) {
  const bus = new BusV2({ dataDir: dir, secret: "test" });
  buses.push(bus);
  return { bus, dir };
}
afterEach(() => {
  for (const bus of buses.splice(0)) bus.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const input = (payload: Record<string, unknown> = {}): FactInput => ({ type: "obs", author: "a", ts: 1, payload });

describe("Node event object contract", () => {
  it("normalizes defaults once for stored content and deduplicates an exact retry", () => {
    const { bus } = open();
    const event = { ...input(), refs: { subject: "status", parent: "", answers: undefined }, nonce: "" };
    const result = bus.append(event);
    const stored = bus.get(result.id)!;
    expect(stored.refs).toEqual({ subject: "status" });
    expect(stored).not.toHaveProperty("nonce");
    expect(computeId(stored)).toBe(result.id);
    expect(bus.append({ ...input(), refs: { subject: "status" } })).toMatchObject({ id: result.id, seq: result.seq, deduped: true });
    expect(bus.append({ ...event, ts: 2 }).deduped).toBe(false);
  });

  it("preserves ordinary Node JSON through hashing, HTTP, disk and recovery", async () => {
    const dir = directory();
    const { app, bus } = createServerV2({ dataDir: dir, secret: "test" });
    buses.push(bus);
    const event = input({ tiny: 1e-7, "10": "ten", "2": "two", nested: { ts: 4, values: [null, true, "中文", { n: -0 }] } });
    const id = computeId(event);
    const response = await app.request("/facts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
    expect(response.status).toBe(201);
    expect((await response.json()).id).toBe(id);
    const stored = bus.get(id)!;
    expect(JSON.parse(readFileSync(join(dir, "facts-v2.jsonl"), "utf8"))).toEqual(stored);
    expect(await (await app.request(`/facts/${id}`)).json()).toEqual(stored);
    expect(computeId(stored)).toBe(id);
    bus.close();
    const recovered = open(dir).bus;
    expect(recovered.get(id)).toEqual(stored);
    expect(computeId(recovered.get(id)!)).toBe(id);
    expect(recovered.append(event).deduped).toBe(true);
  });

  it("includes __proto__ in content identity and round-trips it over HTTP", async () => {
    const { app, bus } = createServerV2({ dataDir: directory(), secret: "test" });
    buses.push(bus);
    const event = input(JSON.parse('{"__proto__":{"value":1},"nested":{"__proto__":2}}'));
    expect(computeId(event)).not.toBe(computeId(input({ nested: {} })));
    for (const payload of [event.payload, {}]) {
      const res = await app.request("/facts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input(payload)) });
      expect(res.status).toBe(201);
    }
    expect(bus.get(computeId(event))!.payload).toEqual(event.payload);
    expect(Object.hasOwn(bus.get(computeId(event))!.payload, "__proto__")).toBe(true);
    expect(Object.prototype).not.toHaveProperty("value");
  });

  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const [label, value] of Object.entries({
    undefined, nan: NaN, infinity: Infinity, date: new Date(0), bigint: 1n,
    function: () => 1, symbol: Symbol("x"), cycle: cyclic, sparse: Array(2),
  })) {
    it(`rejects ${label} before hashing or writing`, () => {
      const { bus, dir } = open();
      const valid = bus.append(input());
      const before = readFileSync(join(dir, "facts-v2.jsonl"), "utf8");
      const invalid = input({ value });
      expect(() => computeId(invalid)).toThrow(FactInputError);
      expect(() => bus.append(invalid)).toThrow(FactInputError);
      expect(bus.headSeq()).toBe(valid.seq);
      expect(readFileSync(join(dir, "facts-v2.jsonl"), "utf8")).toBe(before);
    });
  }

  it("uses the same validation for HTTP and local append", async () => {
    const { app, bus } = createServerV2({ dataDir: directory(), secret: "test" });
    buses.push(bus);
    for (const invalid of [
      { ...input(), payload: null }, { ...input(), payload: [] }, { ...input(), refs: null },
      { ...input(), refs: { parent: 1 } }, { ...input(), nonce: 1 }, { ...input(), id: 1 },
    ]) {
      expect(() => bus.append(invalid as unknown as FactInput)).toThrow(FactInputError);
      const response = await app.request("/facts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invalid) });
      expect(response.status).toBe(400);
    }
    const overflow = await app.request("/facts", { method: "POST", headers: { "content-type": "application/json" }, body: '{"type":"t","author":"a","ts":1,"payload":{"n":1e400}}' });
    expect(overflow.status).toBe(400);
    expect(bus.headSeq()).toBe(0);
  });

  it("isolates submitted data and every bus read result from the journal", () => {
    const { bus, dir } = open();
    const event = { ...input({ nested: { value: 1 } }), refs: { subject: "status" } };
    const { id } = bus.append(event);
    const original = bus.get(id)!;
    (event.payload!.nested as { value: number }).value = 2;
    event.refs.subject = "changed";
    for (const exposed of [bus.get(id)!, bus.read()[0], bus.all()[0]]) {
      (exposed.payload.nested as { value: number }).value = 3;
      exposed.refs.subject = "changed-again";
      exposed.seq = 999;
    }
    (bus.all() as unknown[]).pop();
    expect(bus.all()).toEqual([original]);
    bus.close();
    expect(open(dir).bus.all()).toEqual([original]);
  });
});

describe("full history and state semantics", () => {
  it("retains vote content, historical values and disk bytes through all compaction entry points", async () => {
    const dir = directory();
    const { app, bus } = createServerV2({ dataDir: dir, secret: "test" });
    buses.push(bus);
    const old = bus.append({ ...input({ value: 1 }), refs: { subject: "status" } });
    bus.append({ ...input({ value: 2 }), refs: { subject: "status" } });
    const target = bus.append({ ...input({ value: 3 }), type: "other" });
    const vote = bus.append({ type: "_.vote", author: "b", ts: 2, refs: { vote: target.id }, payload: { verdict: "corroborate" } });
    bus.append({ type: "_.tombstone", author: "b", ts: 3, refs: { tombstones: vote.id } });
    const stream = bus.all();
    const before = readFileSync(join(dir, "facts-v2.jsonl"), "utf8");
    expect(trust(stream, target.id)).toBe("corroborated");
    expect(bus.compact(new Set([old.id, vote.id]))).toBe(0);
    expect(bus.rewrite()).toBe(0);
    const log = new JsonlLog(dir);
    expect(log.compact([...stream], new Set([vote.id]))).toBe(0);
    log.close();
    expect(await (await app.request("/admin/rewrite", { method: "POST" })).json()).toEqual({ stripped: 0 });
    expect(readFileSync(join(dir, "facts-v2.jsonl"), "utf8")).toBe(before);
    expect(bus.all()).toEqual(stream);
    bus.close();
    const recovered = open(dir).bus;
    expect(recovered.all()).toEqual(stream);
    expect(trust(recovered.all(), target.id)).toBe("corroborated");
    expect(history(recovered.all(), "status").map((f) => f.payload)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("keeps completed processing while retracting the current statement", () => {
    const { bus, dir } = open();
    const target = bus.append({ ...input({ value: 1 }), refs: { subject: "status" } });
    bus.append({ type: "_.claim", author: "worker", ts: 2, refs: { claim_of: target.id } });
    bus.append({ type: "_.resolve", author: "worker", ts: 3, refs: { resolves: target.id } });
    bus.append({ type: "_.tombstone", author: "a", ts: 4, refs: { tombstones: target.id } });
    expect(lifecycle(bus.all(), target.id)).toEqual({ state: "resolved", owner: "worker" });
    expect(current(bus.all(), "status")).toBeNull();
    bus.close();
    const recovered = open(dir).bus;
    expect(lifecycle(recovered.all(), target.id)).toEqual({ state: "resolved", owner: "worker" });
    expect(current(recovered.all(), "status")).toBeNull();
  });

  it("still loads old stripped records without inventing their lost payload", () => {
    const { bus, dir } = open();
    const { id } = bus.append(input({ old: "data" }));
    const legacy = { ...bus.get(id)!, payload: {} };
    bus.close();
    writeFileSync(join(dir, "facts-v2.jsonl"), JSON.stringify(legacy) + "\n");
    const recovered = open(dir).bus;
    expect(recovered.get(id)).toEqual(legacy);
    expect(recovered.rewrite()).toBe(0);
    expect(recovered.append({ ...input(), ts: 2 }).seq).toBe(2);
  });
});
