import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../../src/v2/bus.js";
import { createServerV2 } from "../../src/v2/server.js";

const tmp = () => mkdtempSync(join(tmpdir(), "antlegion-v2-info-"));

describe("R2 — INFO (the redis INFO analog)", () => {
  it("reports protocol, head_seq, facts, fsync policy and a stable-secret flag", () => {
    const bus = new BusV2({ secret: "s", dataDir: tmp(), fsync: "everysec" });
    bus.append({ type: "a", author: "x", ts: 1 });
    const info = bus.info();
    expect(info.protocol).toBe("2.0");
    expect(info.head_seq).toBe(1);
    expect(info.facts).toBe(1);
    expect(info.fsync).toBe("everysec");
    expect(info.secret_stable).toBe(true);
    expect(typeof info.uptime_seconds).toBe("number");
    bus.close();
  });

  it("counts dedup hits", () => {
    const bus = new BusV2({ secret: "s", dataDir: tmp() });
    const input = { type: "a", author: "x", ts: 1, payload: { v: 1 } };
    bus.append(input);
    bus.append(input);
    bus.append(input);
    expect(bus.info().dedup_hits).toBe(2);
    bus.close();
  });

  it("a server exposes /info and /admin/rewrite", async () => {
    const { app } = createServerV2({ secret: "s", dataDir: tmp() });
    const info = await (await app.request("/info")).json();
    expect(info.protocol).toBe("2.0");
    const rw = await (await app.request("/admin/rewrite", { method: "POST" })).json();
    expect(typeof rw.stripped).toBe("number");
  });
});

describe("R3 — fsync policy + durability ergonomics", () => {
  it("everysec recovers all facts across a reopen", () => {
    const dir = tmp();
    const bus1 = new BusV2({ secret: "s", dataDir: dir, fsync: "everysec" });
    bus1.append({ type: "a", author: "x", ts: 1 });
    bus1.append({ type: "b", author: "x", ts: 2 });
    bus1.close(); // flush

    const bus2 = new BusV2({ secret: "s", dataDir: dir, fsync: "everysec" });
    expect(bus2.read({}).map((f) => f.type)).toEqual(["a", "b"]);
    bus2.close();
  });

  it("'no' policy still recovers (flush on close)", () => {
    const dir = tmp();
    const bus1 = new BusV2({ secret: "s", dataDir: dir, fsync: "no" });
    bus1.append({ type: "a", author: "x", ts: 1 });
    bus1.close();
    const bus2 = new BusV2({ secret: "s", dataDir: dir, fsync: "no" });
    expect(bus2.read({}).length).toBe(1);
    bus2.close();
  });

  // ── probe: appends AFTER a rewrite must survive (fd must reopen the new file,
  //    not keep writing into the unlinked pre-rewrite inode) ──
  it("appends after rewrite() are durable (no lost-inode bug)", () => {
    const dir = tmp();
    const bus1 = new BusV2({ secret: "s", dataDir: dir, fsync: "everysec" });
    bus1.append({ type: "a", author: "x", ts: 1 });
    bus1.append({ type: "b", author: "x", ts: 2 });
    bus1.rewrite();                                    // temp-file + rename
    bus1.append({ type: "c", author: "x", ts: 3 });    // must land in the NEW file
    bus1.close();

    const bus2 = new BusV2({ secret: "s", dataDir: dir, fsync: "everysec" });
    expect(bus2.read({}).map((f) => f.type)).toEqual(["a", "b", "c"]);
    expect(bus2.headSeq()).toBe(3);
    bus2.close();
  });

  it("rewrite() strips the payload of a tombstoned fact but keeps its skeleton", () => {
    const dir = tmp();
    const bus = new BusV2({ secret: "s", dataDir: dir });
    const a = bus.append({ type: "doomed", author: "x", ts: 1, payload: { big: "data" } });
    bus.append({ type: "_.tombstone", author: "gc", ts: 2, refs: { tombstones: a.id }, nonce: "1" });
    expect(bus.rewrite()).toBe(1); // one payload stripped
    expect(bus.get(a.id)!.payload).toEqual({});
    expect(bus.get(a.id)!.author).toBe("x"); // skeleton kept
    bus.close();
  });
});
