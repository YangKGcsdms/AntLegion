/**
 * §3.3 subject registers + §3.4 forward causation — the "shared world state"
 * folds. Two readers on two machines must fold the same current value, the
 * same history, and the same descendants from the same stream.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fact } from "../src/types.js";
import { current, history, descendants, supersededBy, isSuperseded } from "../src/fold.js";
import { BusV2 } from "../src/bus.js";
import { ClientV2, localTransport } from "../src/client.js";
import { runCli } from "../src/cli.js";

function f(seq: number, author: string, refs: Fact["refs"], type = "x", payload: Record<string, unknown> = {}): Fact {
  return { seq, recv: 1000 + seq, id: "id" + seq, type, author, ts: 1, payload, refs, sig: "" };
}

describe("fold — subject register (§3.3): what is X right now", () => {
  it("nothing written → null; one write → that fact", () => {
    expect(current([], "deploy:prod")).toBeNull();
    const s = [f(1, "A", { subject: "deploy:prod" }, "deploy.status", { v: 1 })];
    expect(current(s, "deploy:prod")?.id).toBe("id1");
  });

  it("latest seq in the group wins; earlier members fold as superseded", () => {
    const s = [
      f(1, "A", { subject: "deploy:prod" }, "deploy.status", { v: 1 }),
      f(2, "B", { subject: "deploy:prod" }, "deploy.status", { v: 2 }),
      f(3, "A", { subject: "deploy:prod" }, "deploy.status", { v: 3 }),
    ];
    expect(current(s, "deploy:prod")?.payload).toEqual({ v: 3 });
    expect(isSuperseded(s, "id1")).toBe(true);
    expect(supersededBy(s, "id2")).toBe("id3");
    expect(isSuperseded(s, "id3")).toBe(false);
  });

  it("history returns the whole group oldest-first (no latest-wins applied)", () => {
    const s = [
      f(1, "A", { subject: "k" }), f(2, "B", { subject: "other" }), f(3, "C", { subject: "k" }),
    ];
    expect(history(s, "k").map((x) => x.id)).toEqual(["id1", "id3"]);
  });

  it("explicit supersedes beats group order and may leave the subject behind", () => {
    const s = [
      f(1, "A", { subject: "k" }, "v", { v: 1 }),
      f(2, "A", { subject: "k" }, "v", { v: 2 }),
      f(3, "B", { supersedes: "id2" }, "v", { v: 3 }), // no subject on the successor
    ];
    expect(current(s, "k")?.id).toBe("id3");
  });

  it("a tombstoned current retracts the register: null, not the previous value", () => {
    const s = [
      f(1, "A", { subject: "k" }, "v", { v: 1 }),
      f(2, "A", { subject: "k" }, "v", { v: 2 }),
      f(3, "A", { tombstones: "id2" }, "_.tombstone"),
    ];
    expect(current(s, "k")).toBeNull();
    // and deleted is NOT superseded (§5.2)
    expect(isSuperseded(s, "id2")).toBe(false);
  });

  it("two readers, same stream, same answer regardless of read order", () => {
    const s = [
      f(1, "A", { subject: "k" }, "v", { v: 1 }),
      f(2, "B", { subject: "k" }, "v", { v: 2 }),
    ];
    const shuffled = [s[1], s[0]];
    expect(current(s, "k")?.id).toBe(current(shuffled, "k")?.id);
    expect(history(shuffled, "k").map((x) => x.id)).toEqual(["id1", "id2"]);
  });
});

describe("fold — descendants (§3.4 forward): what did F lead to", () => {
  it("returns transitive children in seq order, excluding F", () => {
    const s = [
      f(1, "A", {}, "obs"),
      f(2, "B", { parent: "id1" }, "plan"),
      f(3, "C", { parent: "id2" }, "build"),
      f(4, "D", { parent: "id1" }, "note"),
      f(5, "E", {}, "unrelated"),
    ];
    expect(descendants(s, "id1").map((x) => x.id)).toEqual(["id2", "id3", "id4"]);
    expect(descendants(s, "id2").map((x) => x.id)).toEqual(["id3"]);
    expect(descendants(s, "id5")).toEqual([]);
  });
});

function harness(author = "A") {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-ws-"));
  const bus = new BusV2({ secret: "t", dataDir: dir });
  const client = new ClientV2(localTransport(bus), author);
  return { bus, client };
}

describe("client — registers, supersede, tombstone, descendants", () => {
  it("currentOf/historyOf agree between two isolated clients on one bus", async () => {
    const { bus, client: a } = harness("machine-a");
    const b = new ClientV2(localTransport(bus), "machine-b");
    await a.publish("deploy.status", { v: 1 }, { refs: { subject: "deploy:prod" } });
    const r2 = await a.publish("deploy.status", { v: 2 }, { refs: { subject: "deploy:prod" } });
    expect((await b.currentOf("deploy:prod"))?.id).toBe(r2.id);
    expect((await a.currentOf("deploy:prod"))?.id).toBe(r2.id);
    expect((await b.historyOf("deploy:prod")).length).toBe(2);
    expect(await b.supersededBy(r2.id)).toBeNull();
  });

  it("supersede inherits the subject so the register moves; tombstone retracts it", async () => {
    const { client: a } = harness();
    const r1 = await a.publish("belief", { x: 1 }, { refs: { subject: "belief:x" } });
    const r2 = await a.supersede(r1.id, "belief", { x: 2 });
    expect(await a.supersededBy(r1.id)).toBe(r2.id);
    expect((await a.currentOf("belief:x"))?.id).toBe(r2.id);
    await a.tombstone(r2.id);
    expect(await a.currentOf("belief:x")).toBeNull();
    expect((await a.state(r2.id)).state).toBe("dead");
    await expect(a.tombstone("nope")).rejects.toThrow(/not found/);
  });

  it("descendants: resolve children hang off the parent", async () => {
    const { client: a } = harness();
    const r = await a.publish("task.todo", { t: 1 });
    await a.claim(r.id);
    const { childIds } = await a.resolve(r.id, [{ type: "task.answer", payload: { ok: true } }]);
    const kids = await a.descendants(r.id);
    expect(kids.map((k) => k.id)).toEqual(childIds);
  });
});

describe("alctl — current / history / supersede / tombstone / descendants", () => {
  function cli(author = "cli") {
    const { bus, client } = harness(author);
    const lines: string[] = [];
    const errs: string[] = [];
    const run = (args: string[]) => runCli(args, client, (l) => lines.push(l), (l) => errs.push(l));
    return { bus, client, lines, errs, run };
  }

  it("current exits 1 on an unknown subject and 0 with the current fact", async () => {
    const { lines, run } = cli();
    expect(await run(["current", "deploy:prod"])).toBe(1);
    expect(JSON.parse(lines[0]).current).toBeNull();
    lines.length = 0;
    await run(["publish", "deploy.status", '{"v":1}', "--subject", "deploy:prod"]);
    await run(["publish", "deploy.status", '{"v":2}', "--subject", "deploy:prod"]);
    lines.length = 0;
    expect(await run(["current", "deploy:prod"])).toBe(0);
    expect(JSON.parse(lines[0]).current.payload).toEqual({ v: 2 });
    lines.length = 0;
    expect(await run(["history", "deploy:prod"])).toBe(0);
    expect(lines.map((l) => JSON.parse(l).payload.v)).toEqual([1, 2]);
  });

  it("supersede moves the register; tombstone retracts it", async () => {
    const { lines, run } = cli();
    await run(["publish", "belief", '{"x":1}', "--subject", "belief:x"]);
    const first = JSON.parse(lines[0]).id;
    lines.length = 0;
    expect(await run(["supersede", first, "belief", '{"x":2}'])).toBe(0);
    const sup = JSON.parse(lines[0]);
    expect(sup.supersedes).toBe(first);
    lines.length = 0;
    await run(["current", "belief:x"]);
    expect(JSON.parse(lines[0]).current.id).toBe(sup.id);
    lines.length = 0;
    expect(await run(["tombstone", sup.id])).toBe(0);
    lines.length = 0;
    expect(await run(["current", "belief:x"])).toBe(1);
  });

  it("causation carries facts; descendants lists what a fact led to", async () => {
    const { lines, run } = cli();
    await run(["publish", "obs.metric", '{"cpu":90}']);
    const root = JSON.parse(lines[0]).id;
    lines.length = 0;
    await run(["publish", "alert.raised", "{}", "--parent", root]);
    const child = JSON.parse(lines[0]).id;
    lines.length = 0;
    expect(await run(["causation", child])).toBe(0);
    const c = JSON.parse(lines[0]);
    expect(c.chain).toEqual([root, child]);
    expect(c.facts[0].payload).toEqual({ cpu: 90 });
    lines.length = 0;
    expect(await run(["descendants", root])).toBe(0);
    expect(JSON.parse(lines[0]).descendants).toEqual([child]);
  });

  it("help lists the world-state verbs", async () => {
    const { lines, run } = cli();
    await run(["help"]);
    const h = lines.join("\n");
    for (const v of ["current <subject>", "history <subject>", "supersede <id>", "tombstone <id>", "descendants <id>"]) {
      expect(h).toContain(v);
    }
  });
});
