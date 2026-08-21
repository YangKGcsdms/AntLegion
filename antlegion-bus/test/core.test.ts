import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import { computeId } from "../src/hash.js";

function freshBus() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-"));
  return { bus: new BusV2({ secret: "test-secret", dataDir: dir }), dir };
}

describe("v2 core — identity & integrity", () => {
  it("id is deterministic and key-order independent", () => {
    const a = computeId({ type: "t", author: "x", ts: 1, payload: { a: 1, b: 2 } });
    const b = computeId({ type: "t", author: "x", ts: 1, payload: { b: 2, a: 1 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("nonce changes the id (forces a distinct fact)", () => {
    const base = { type: "t", author: "x", ts: 1, payload: {} };
    expect(computeId(base)).not.toBe(computeId({ ...base, nonce: "n1" }));
    expect(computeId({ ...base, nonce: "n1" })).not.toBe(computeId({ ...base, nonce: "n2" }));
  });

  it("an empty refs object is omitted from the record, so it does not affect the id", () => {
    const a = computeId({ type: "t", author: "x", ts: 1, payload: {} });
    const b = computeId({ type: "t", author: "x", ts: 1, payload: {}, refs: {} });
    expect(a).toBe(b);
  });

  it('an empty-string refs value or nonce is REJECTED, not silently dropped', () => {
    // §1.1. v2.0 dropped these while hashing, which made the content address
    // depend on a normalization rule no second implementation could have known.
    const { bus } = freshBus();
    expect(() => bus.append({ type: "t", author: "x", ts: 1, refs: { parent: "" } })).toThrow(/non-empty string/);
    expect(() => bus.append({ type: "t", author: "x", ts: 1, nonce: "" })).toThrow(/non-empty string/);
  });
});

describe("v2 core — append", () => {
  it("assigns monotonic seq, trusted recv, and a signature", () => {
    const { bus } = freshBus();
    const r1 = bus.append({ type: "demo", author: "a", ts: 1 });
    const r2 = bus.append({ type: "demo", author: "a", ts: 2 });
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(r1.recv).toBeGreaterThan(0);
    expect(r1.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.deduped).toBe(false);
  });

  it("is idempotent by id: resubmitting identical content dedups", () => {
    const { bus } = freshBus();
    const input = { type: "demo", author: "a", ts: 1, payload: { x: 1 } };
    const r1 = bus.append(input);
    const r2 = bus.append(input);
    expect(r2.deduped).toBe(true);
    expect(r2.seq).toBe(r1.seq);
    expect(bus.headSeq()).toBe(1); // no second copy
  });

  it("a fresh nonce makes a legitimate repeat distinct", () => {
    const { bus } = freshBus();
    const r1 = bus.append({ type: "_.claim", author: "a", ts: 1, refs: { claim_of: "F" }, nonce: "1" });
    const r2 = bus.append({ type: "_.claim", author: "a", ts: 1, refs: { claim_of: "F" }, nonce: "2" });
    expect(r2.deduped).toBe(false);
    expect(r2.seq).toBe(r1.seq + 1);
  });

  it("rejects a client-supplied id that mismatches the content", () => {
    const { bus } = freshBus();
    expect(() => bus.append({ type: "demo", author: "a", ts: 1, id: "deadbeef" })).toThrow(/id mismatch/);
  });
});

describe("v2 core — read", () => {
  it("since acts as a cursor returning only newer facts, ascending", () => {
    const { bus } = freshBus();
    bus.append({ type: "a", author: "x", ts: 1 });
    bus.append({ type: "b", author: "x", ts: 2 });
    bus.append({ type: "c", author: "x", ts: 3 });
    const after1 = bus.read({ since: 1 });
    expect(after1.map((f) => f.type)).toEqual(["b", "c"]);
  });

  it("filters by type glob, author, and refs", () => {
    const { bus } = freshBus();
    bus.append({ type: "build.failed", author: "ci", ts: 1 });
    bus.append({ type: "build.passed", author: "ci", ts: 2 });
    bus.append({ type: "_.claim", author: "worker", ts: 3, refs: { claim_of: "F1" }, nonce: "1" });
    expect(bus.read({ type: "build.*" }).length).toBe(2);
    expect(bus.read({ author: "worker" }).length).toBe(1);
    expect(bus.read({ ref: { key: "claim_of", value: "F1" } }).length).toBe(1);
  });

  it("respects limit", () => {
    const { bus } = freshBus();
    for (let i = 0; i < 10; i++) bus.append({ type: "t", author: "x", ts: i });
    expect(bus.read({ limit: 3 }).length).toBe(3);
  });
});

describe("v2 core — recovery", () => {
  it("rebuilds facts, seq counter, and dedup index from the log", () => {
    const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-"));
    const bus1 = new BusV2({ secret: "s", dataDir: dir });
    bus1.append({ type: "a", author: "x", ts: 1, payload: { v: 1 } });
    bus1.append({ type: "b", author: "x", ts: 2 });

    const bus2 = new BusV2({ secret: "s", dataDir: dir });
    expect(bus2.headSeq()).toBe(2);
    expect(bus2.read({}).map((f) => f.type)).toEqual(["a", "b"]);
    // dedup index survived: re-appending the first fact dedups against seq 1
    const r = bus2.append({ type: "a", author: "x", ts: 1, payload: { v: 1 } });
    expect(r.deduped).toBe(true);
    expect(r.seq).toBe(1);
    expect(bus2.headSeq()).toBe(2);
  });
});
