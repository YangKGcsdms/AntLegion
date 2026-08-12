import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import { ClientV2, localTransport } from "../src/client.js";
import { runCli } from "../src/cli.js";

function harness(author = "cli") {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-cli-"));
  const bus = new BusV2({ secret: "t", dataDir: dir });
  const client = new ClientV2(localTransport(bus), author);
  const lines: string[] = [];
  const errs: string[] = [];
  const run = (args: string[]) => runCli(args, client, (l) => lines.push(l), (l) => errs.push(l));
  return { bus, client, lines, errs, run };
}

describe("alctl — the redis-cli analog", () => {
  it("help with no args, exit 0", async () => {
    const { lines, run } = harness();
    expect(await run([])).toBe(0);
    expect(lines.join("\n")).toContain("AntLegion CLI");
  });

  it("publish prints {id, seq, deduped} as JSON", async () => {
    const { lines, run } = harness();
    expect(await run(["publish", "demo.hello", '{"msg":"hi"}'])).toBe(0);
    const out = JSON.parse(lines[0]);
    expect(out.id).toMatch(/^[0-9a-f]{64}$/);
    expect(out.seq).toBe(1);
    expect(out.deduped).toBe(false);
  });

  it("read lists facts as JSONL and filters by --type", async () => {
    const { lines, run } = harness();
    await run(["publish", "build.failed", "{}"]);
    await run(["publish", "build.passed", "{}"]);
    await run(["publish", "noise", "{}"]);
    lines.length = 0;
    expect(await run(["read", "--type", "build.*"])).toBe(0);
    expect(lines).toHaveLength(2);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual(["build.failed", "build.passed"]);
  });

  it("claim → state → resolve flow", async () => {
    const { lines, run, client } = harness();
    await run(["publish", "task", "{}"]);
    const id = (await client.query({ type: "task" }))[0].id;

    lines.length = 0;
    expect(await run(["claim", id])).toBe(0);
    expect(JSON.parse(lines[0])).toEqual({ won: true, winner: "cli" });

    lines.length = 0;
    await run(["state", id]);
    expect(JSON.parse(lines[0])).toEqual({ state: "claimed", owner: "cli" });

    lines.length = 0;
    expect(await run(["resolve", id])).toBe(0);
    expect(JSON.parse(lines[0])).toEqual({ state: "resolved", owner: "cli" });
  });

  it("losing a claim exits non-zero and names the winner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-cli-"));
    const bus = new BusV2({ secret: "t", dataDir: dir });
    const a = new ClientV2(localTransport(bus), "alice");
    const b = new ClientV2(localTransport(bus), "bob");
    const { id } = await a.publish("task", {});
    await a.claim(id); // alice wins (lower seq)
    const lines: string[] = [];
    const code = await runCli(["claim", id], b, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(JSON.parse(lines[0])).toEqual({ won: false, winner: "alice" });
  });

  it("info prints the full INFO payload as JSON", async () => {
    const { lines, run } = harness();
    await run(["publish", "a", "{}"]);
    await run(["publish", "b", "{}"]);
    lines.length = 0;
    expect(await run(["info"])).toBe(0);
    const info = JSON.parse(lines[0]);
    expect(info.protocol).toBe("2.0");
    expect(info.facts).toBe(2);
    expect(info.head_seq).toBe(2);
    expect(info.fsync).toBeDefined();
    expect(info.sig_failures).toBe(0);
    expect(info.secret_stable).toBe(true);
  });

  it("unknown command exits non-zero", async () => {
    const { run } = harness();
    expect(await run(["frobnicate"])).toBe(1);
  });

  it("--author sets the identity for publish/claim/resolve", async () => {
    const { bus, lines, run } = harness();
    expect(await run(["publish", "task", "{}", "--author", "alice"])).toBe(0);
    const id = JSON.parse(lines[0]).id;
    expect(bus.get(id)!.author).toBe("alice"); // the flag is not silently ignored

    expect(await run(["claim", id, "--author", "alice"])).toBe(0);
    expect(await run(["state", id])).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ state: "claimed", owner: "alice" });

    // resolve as bob: fails loudly on stderr, exit non-zero
    const errsBefore = lines.length;
    expect(await run(["resolve", id, "--author", "bob"])).toBe(1);
    expect(lines.length).toBe(errsBefore); // nothing on stdout
    expect(await run(["resolve", id, "--author", "alice"])).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ state: "resolved", owner: "alice" });
  });

  it("resolve by a non-winner fails loudly and state is unchanged", async () => {
    const { lines, errs, run } = harness();
    await run(["publish", "task", "{}", "--author", "alice"]);
    const id = JSON.parse(lines[0]).id;
    await run(["claim", id, "--author", "alice"]);

    lines.length = 0;
    expect(await run(["resolve", id, "--author", "bob"])).toBe(1);
    expect(lines).toHaveLength(0); // stdout stays clean
    expect(errs.at(-1)).toBe(`error: resolve ignored — fact ${id} is owned by 'alice' (you are 'bob')`);

    await run(["state", id]);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ state: "claimed", owner: "alice" });
  });

  it("claim on a nonexistent fact errors instead of winning", async () => {
    const { lines, errs, run } = harness();
    const missing = "0".repeat(64);
    expect(await run(["claim", missing])).toBe(1);
    expect(lines).toHaveLength(0);
    expect(errs.at(-1)).toBe(`error: fact ${missing} not found`);
  });

  it("release by the owner reopens the fact; by anyone else it fails", async () => {
    const { lines, errs, run } = harness();
    await run(["publish", "task", "{}", "--author", "alice"]);
    const id = JSON.parse(lines[0]).id;
    await run(["claim", id, "--author", "alice"]);

    expect(await run(["release", id, "--author", "bob"])).toBe(1);
    expect(errs.at(-1)).toBe(`error: release ignored — fact ${id} is owned by 'alice' (you are 'bob')`);

    lines.length = 0;
    expect(await run(["release", id, "--author", "alice"])).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ state: "open", owner: null });
  });

  it("an invalid JSON payload is a clean error, not a stack trace", async () => {
    const { lines, errs, run } = harness();
    expect(await run(["publish", "task", "{not json"])).toBe(1);
    expect(lines).toHaveLength(0);
    expect(errs.at(-1)).toMatch(/^error: invalid JSON payload: /);
  });
});
