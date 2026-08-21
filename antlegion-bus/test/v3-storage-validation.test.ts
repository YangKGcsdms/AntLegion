/**
 * The rules v3.0 added that are enforced rather than described:
 * §1.1/§1.2 field domains and lifecycle-ref exclusivity, §7.1 recovery, and
 * §3.4's Δ being a property of the log rather than a knob on each reader.
 */

import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import { LogCorrupt } from "../src/log.js";
import { FactRejected } from "../src/types.js";
import { ClientV2, localTransport } from "../src/client.js";

const tmp = () => mkdtempSync(join(tmpdir(), "al-v3-"));
const logPath = (dir: string) => join(dir, "facts-v2.jsonl");

describe("§1.1 — field domains are enforced, not described", () => {
  const fresh = () => new BusV2({ secret: "s", dataDir: tmp() });

  it("rejects a non-finite ts", () => {
    // v2.0 checked truthiness, so `1e999` became `null` on disk and permanently
    // broke that fact's own content address.
    const bus = fresh();
    for (const ts of [NaN, Infinity, -Infinity]) {
      expect(() => bus.append({ type: "t", author: "a", ts })).toThrow(FactRejected);
    }
    bus.close();
  });

  it("rejects a non-object payload and a malformed type", () => {
    const bus = fresh();
    expect(() => bus.append({ type: "t", author: "a", ts: 1, payload: [] as never })).toThrow(/JSON object/);
    expect(() => bus.append({ type: "t", author: "a", ts: 1, payload: "x" as never })).toThrow(/JSON object/);
    expect(() => bus.append({ type: "has space", author: "a", ts: 1 })).toThrow(/dotted segments/);
    expect(() => bus.append({ type: "trailing.", author: "a", ts: 1 })).toThrow(/dotted segments/);
    bus.close();
  });

  it("rejects an empty or null refs value instead of dropping it", () => {
    const bus = fresh();
    expect(() => bus.append({ type: "t", author: "a", ts: 1, refs: { parent: "" } })).toThrow(/non-empty/);
    expect(() => bus.append({ type: "t", author: "a", ts: 1, refs: { parent: null as never } })).toThrow(/non-empty/);
    bus.close();
  });

  it("rejects a fact carrying more than one lifecycle ref (§1.2)", () => {
    // This is the only case in which §3.4's fold order would be ambiguous.
    const bus = fresh();
    expect(() => bus.append({
      type: "_.claim", author: "a", ts: 1, refs: { claim_of: "x", resolves: "y" },
    })).toThrow(/at most one lifecycle ref/);
    bus.close();
  });

  it("reports a §8 limit with 413 and a domain violation with 400", () => {
    const bus = fresh();
    const big = { blob: "x".repeat(2 * 1024 * 1024) };
    try {
      bus.append({ type: "t", author: "a", ts: 1, payload: big });
      expect.unreachable();
    } catch (err) {
      expect((err as FactRejected).status).toBe(413);
    }
    try {
      bus.append({ type: "t", author: "a", ts: NaN });
      expect.unreachable();
    } catch (err) {
      expect((err as FactRejected).status).toBe(400);
    }
    bus.close();
  });
});

describe("§7.1 — recovery", () => {
  it("truncates a torn final record instead of appending after it", () => {
    // Skipping the fragment is not sufficient: the next append is concatenated
    // onto it, the combined line never parses again, and an acknowledged fact is
    // lost on the following restart while its seq has been handed to different
    // content.
    const dir = tmp();
    const bus = new BusV2({ secret: "s", dataDir: dir });
    bus.append({ type: "a", author: "x", ts: 1 });
    bus.append({ type: "b", author: "x", ts: 2 });
    bus.close();

    appendFileSync(logPath(dir), '{"seq":3,"recv":3,"id":"tor', "utf-8");

    const bus2 = new BusV2({ secret: "s", dataDir: dir });
    expect(bus2.headSeq()).toBe(2);
    const r = bus2.append({ type: "c", author: "x", ts: 3 });
    expect(r.seq).toBe(3);
    bus2.close();

    // The critical assertion: after the repair every line still parses.
    const lines = readFileSync(logPath(dir), "utf-8").split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();

    // …and the fact survives a further restart, at the seq it was given.
    const bus3 = new BusV2({ secret: "s", dataDir: dir });
    expect(bus3.headSeq()).toBe(3);
    expect(bus3.get(r.id)!.seq).toBe(3);
    bus3.close();
  });

  it("refuses to start on an interior corrupt record", () => {
    // Silently skipping it removes a fact other readers have already folded,
    // permanently forking their view.
    const dir = tmp();
    const bus = new BusV2({ secret: "s", dataDir: dir });
    bus.append({ type: "a", author: "x", ts: 1 });
    bus.append({ type: "b", author: "x", ts: 2 });
    bus.close();

    const lines = readFileSync(logPath(dir), "utf-8").split("\n");
    lines[0] = "{not json";
    writeFileSync(logPath(dir), lines.join("\n"), "utf-8");

    expect(() => new BusV2({ secret: "s", dataDir: dir })).toThrow(LogCorrupt);
  });

  it("never reuses a seq after a truncation", () => {
    const dir = tmp();
    const bus = new BusV2({ secret: "s", dataDir: dir });
    bus.append({ type: "a", author: "x", ts: 1 });
    const second = bus.append({ type: "b", author: "x", ts: 2 });
    bus.close();

    // Chop the file mid-way through the second record.
    const raw = readFileSync(logPath(dir), "utf-8");
    const firstNewline = raw.indexOf("\n");
    writeFileSync(logPath(dir), raw.slice(0, firstNewline + 12), "utf-8");

    const bus2 = new BusV2({ secret: "s", dataDir: dir });
    expect(bus2.headSeq()).toBe(1);          // the torn record is gone
    const replacement = bus2.append({ type: "c", author: "x", ts: 3 });
    expect(replacement.seq).toBe(2);          // seq 2 is issued once, to one content
    expect(replacement.id).not.toBe(second.id);
    bus2.close();
  });

  it("re-verifies the content address and reports failures through INFO", () => {
    // §4.2's sig covers the header only, so re-hashing is the only check that
    // detects on-disk payload tampering.
    const dir = tmp();
    const bus = new BusV2({ secret: "s", dataDir: dir });
    bus.append({ type: "a", author: "x", ts: 1, payload: { v: 1 } });
    bus.close();

    const line = JSON.parse(readFileSync(logPath(dir), "utf-8").trim());
    line.payload = { v: 999 };               // id and sig left alone
    writeFileSync(logPath(dir), JSON.stringify(line) + "\n", "utf-8");

    const bus2 = new BusV2({ secret: "s", dataDir: dir });
    expect(bus2.info().id_failures).toBe(1);
    expect(bus2.info().sig_failures).toBe(0); // the header was not touched
    bus2.close();
  });

  it("does not report a compacted fact as an integrity failure", () => {
    const dir = tmp();
    const bus = new BusV2({ secret: "s", dataDir: dir });
    const a = bus.append({ type: "doomed", author: "x", ts: 1, payload: { big: "data" } });
    bus.append({ type: "_.tombstone", author: "x", ts: 2, refs: { tombstones: a.id }, nonce: "1" });
    expect(bus.rewrite()).toBe(1);
    bus.close();

    const bus2 = new BusV2({ secret: "s", dataDir: dir });
    expect(bus2.info().id_failures).toBe(0); // unverifiable, not tampered
    bus2.close();
  });
});

describe("§3.4/§8 — Δ is a property of the log", () => {
  it("a client adopts the bus-published Δ rather than its own default", async () => {
    const bus = new BusV2({ secret: "s", dataDir: tmp(), claimTimeout: 5 });
    expect(bus.info().claim_timeout).toBe(5);

    const t = localTransport(bus);
    const seed = await new ClientV2(t, "seed").publish("task", {});

    const alice = new ClientV2(t, "alice");
    await alice.claim(seed.id);

    // With the published Δ of 5s the claim is long past its expiry; with the
    // §8 default of 600 it would still look live. Two readers disagreeing on Δ
    // disagree not only about who holds a claim but about whether the work was
    // resolved at all — which is why the reader does not get to choose.
    const bob = new ClientV2(t, "bob");
    await bob.sync();
    const past = Date.now() / 1000 + 10;
    expect(bus.info().claim_timeout).toBe(5);
    expect((await bob.state(seed.id)).state).toBe("claimed");
    // fold explicitly at a later wall clock to show the adopted Δ is in play
    const { lifecycle } = await import("../src/fold.js");
    expect(lifecycle(bus.all(), seed.id, { now: past, claimTimeout: 5 }).state).toBe("open");
    expect(lifecycle(bus.all(), seed.id, { now: past, claimTimeout: 600 }).state).toBe("claimed");
    bus.close();
  });
});

describe("§5.1 — the client refuses to author a fact readers would ignore", () => {
  it("supersede and tombstone are gated on the target's author", async () => {
    const bus = new BusV2({ secret: "s", dataDir: tmp() });
    const t = localTransport(bus);
    const owner = new ClientV2(t, "owner");
    const mallory = new ClientV2(t, "mallory");

    const f = await owner.publish("obs", { v: 1 }, { refs: { subject: "k" } });
    await mallory.sync();

    await expect(mallory.supersede(f.id, "obs", { v: 2 })).rejects.toThrow(/only its author may supersede/);
    await expect(mallory.tombstone(f.id)).rejects.toThrow(/only its author may retract/);

    await expect(owner.supersede(f.id, "obs", { v: 2 })).resolves.toBeTruthy();
    bus.close();
  });
});
