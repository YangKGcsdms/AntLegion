/**
 * §5 causation-depth enforcement + §4 signature verification — the two
 * bus-side safety rules that PROTOCOL.md declares but that were previously
 * unimplemented (closing a spec↔impl gap).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusV2 } from "../src/bus.js";
import { verifySig } from "../src/hash.js";

const dirs: BusV2[] = [];
const fresh = (opts: Partial<{ secret: string; maxDepth: number }> = {}) => {
  const b = new BusV2({ dataDir: mkdtempSync(join(tmpdir(), "sig-")), fsync: "always", secret: "s", ...opts });
  dirs.push(b);
  return b;
};
afterEach(() => { while (dirs.length) dirs.pop()!.close(); });

describe("§5 — causation depth cap", () => {
  it("rejects a chain deeper than maxDepth, accepts up to it", () => {
    const bus = fresh({ maxDepth: 3 });
    const a = bus.append({ type: "c", author: "u", ts: 1, payload: {} }).id;            // depth 1
    const b = bus.append({ type: "c", author: "u", ts: 2, payload: {}, refs: { parent: a } }).id; // 2
    const c = bus.append({ type: "c", author: "u", ts: 3, payload: {}, refs: { parent: b } }).id; // 3 (ok)
    expect(() => bus.append({ type: "c", author: "u", ts: 4, payload: {}, refs: { parent: c } })) // 4 → reject
      .toThrow(/causation depth exceeds max/);
  });

  it("a dangling parent (target absent) is depth 1 and always accepted", () => {
    const bus = fresh({ maxDepth: 1 });
    expect(() => bus.append({ type: "c", author: "u", ts: 1, payload: {}, refs: { parent: "does-not-exist" } }))
      .not.toThrow();
  });

  it("exposes max_depth via INFO", () => {
    expect(fresh({ maxDepth: 7 }).info().max_depth).toBe(7);
  });
});

describe("§4 — signature verification", () => {
  it("verifies a genuine fact and rejects a tampered one", () => {
    const bus = fresh({ secret: "topsecret" });
    const { id } = bus.append({ type: "t", author: "alice", ts: 1, payload: { x: 1 } });
    const fact = bus.get(id)!;
    expect(verifySig("topsecret", fact)).toBe(true);
    expect(verifySig("topsecret", { ...fact, author: "mallory" })).toBe(false); // tampered author
    expect(verifySig("topsecret", { ...fact, seq: fact.seq + 1 })).toBe(false); // tampered seq
    expect(verifySig("wrong-secret", fact)).toBe(false);                        // wrong key
  });

  it("recovery under a stable secret verifies the log; a foreign secret flags every fact", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    const a = new BusV2({ dataDir: dir, fsync: "always", secret: "A" });
    a.append({ type: "t", author: "u", ts: 1, payload: {} });
    a.append({ type: "t", author: "u", ts: 2, payload: {} });
    a.close();

    const sameKey = new BusV2({ dataDir: dir, fsync: "always", secret: "A" });
    expect(sameKey.info().sig_failures).toBe(0);     // genuine log verifies clean
    sameKey.close();

    const wrongKey = new BusV2({ dataDir: dir, fsync: "always", secret: "B" });
    expect(wrongKey.info().sig_failures).toBe(2);     // every fact fails under a foreign secret
    wrongKey.close();
  });

  it("does not verify (sig_failures stays 0) when the secret is unstable/random", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec2-"));
    const a = new BusV2({ dataDir: dir, fsync: "always", secret: "A" });
    a.append({ type: "t", author: "u", ts: 1, payload: {} });
    a.close();
    const random = new BusV2({ dataDir: dir, fsync: "always" }); // no secret → minted, unstable
    expect(random.info().secret_stable).toBe(false);
    expect(random.info().sig_failures).toBe(0);
    random.close();
  });
});
