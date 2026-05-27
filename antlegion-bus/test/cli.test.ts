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
  const run = (args: string[]) => runCli(args, client, (l) => lines.push(l));
  return { bus, client, lines, run };
}

describe("alctl — the redis-cli analog", () => {
  it("help with no args, exit 0", async () => {
    const { lines, run } = harness();
    expect(await run([])).toBe(0);
    expect(lines.join("\n")).toContain("AntLegion CLI");
  });

  it("publish prints id + seq", async () => {
    const { lines, run } = harness();
    expect(await run(["publish", "demo.hello", '{"msg":"hi"}'])).toBe(0);
    expect(lines[0]).toMatch(/^published [0-9a-f]{64}  seq=1$/);
  });

  it("read lists facts and filters by --type", async () => {
    const { lines, run } = harness();
    await run(["publish", "build.failed", "{}"]);
    await run(["publish", "build.passed", "{}"]);
    await run(["publish", "noise", "{}"]);
    lines.length = 0;
    await run(["read", "--type", "build.*"]);
    expect(lines.filter((l) => l.includes("build.")).length).toBe(2);
    expect(lines.at(-1)).toBe("(2 facts)");
  });

  it("claim → state → resolve flow", async () => {
    const { lines, run, client } = harness();
    await run(["publish", "task", "{}"]);
    const id = (await client.query({ type: "task" }))[0].id;

    lines.length = 0;
    expect(await run(["claim", id])).toBe(0);
    expect(lines[0]).toBe(`won ${id}`);

    lines.length = 0;
    await run(["state", id]);
    expect(lines[0]).toBe("claimed  owner=cli");

    lines.length = 0;
    await run(["resolve", id]);
    await run(["state", id]);
    expect(lines.at(-1)).toBe("resolved  owner=cli");
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
    expect(lines[0]).toBe(`lost ${id} (winner: alice)`);
  });

  it("info reports facts and head_seq", async () => {
    const { lines, run } = harness();
    await run(["publish", "a", "{}"]);
    await run(["publish", "b", "{}"]);
    lines.length = 0;
    await run(["info"]);
    expect(lines[0]).toBe("facts=2  head_seq=2");
  });

  it("unknown command exits non-zero", async () => {
    const { run } = harness();
    expect(await run(["frobnicate"])).toBe(1);
  });
});
