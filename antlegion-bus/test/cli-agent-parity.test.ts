/**
 * cli-agent-parity.test.ts — the alctl CLI is the agent↔bus interface that
 * REPLACED the MCP adapter. This ports the exact scenarios the old
 * mcp.test.ts covered (publish→claim→state→resolve, cursor query, causation,
 * observer consensus, losing claimant) to the CLI, proving no capability was
 * lost in the migration. Agents that used MCP tools now shell out to alctl.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusV2 } from "../src/bus.js";
import { ClientV2, localTransport } from "../src/client.js";
import { runCli } from "../src/cli.js";

/** One shared bus, per-author CLIs — mirrors how N agents share one bus. */
function colony() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-v2-cliparity-"));
  const bus = new BusV2({ secret: "t", dataDir: dir });
  const out = new Map<string, string[]>();
  const cli = (author: string) => {
    const lines: string[] = [];
    out.set(author, lines);
    const client = new ClientV2(localTransport(bus), author);
    return {
      client,
      lines,
      run: (args: string[]) => runCli(args, client, (l) => lines.push(l), () => {}),
    };
  };
  return { bus, cli };
}

const lastJSON = (lines: string[]) => JSON.parse(lines[lines.length - 1]);

describe("alctl agent parity (replaces MCP)", () => {
  it("publish → claim → state → resolve → state", async () => {
    const { cli } = colony();
    const a = cli("agent");
    expect(await a.run(["publish", "task.x", '{"a":1}'])).toBe(0);
    const id = lastJSON(a.lines).id;
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    expect(await a.run(["claim", id])).toBe(0);
    expect(lastJSON(a.lines)).toMatchObject({ won: true });

    await a.run(["state", id]);
    expect(lastJSON(a.lines)).toEqual({ state: "claimed", owner: "agent" });

    expect(await a.run(["resolve", id])).toBe(0);
    expect(lastJSON(a.lines)).toEqual({ state: "resolved", owner: "agent" });
  });

  it("read advances by --since cursor and filters by --type", async () => {
    const { cli } = colony();
    const a = cli("agent");
    await a.run(["publish", "ev.a", "{}"]);
    await a.run(["publish", "ev.b", "{}"]);
    a.lines.length = 0;
    await a.run(["read", "--type", "ev.*"]);
    expect(a.lines.length).toBe(2);
    // cursor: read since the first seq → only the second remains
    a.lines.length = 0;
    await a.run(["read", "--type", "ev.*", "--since", "1"]);
    expect(a.lines.length).toBe(1);
    expect(JSON.parse(a.lines[0]).type).toBe("ev.b");
  });

  it("causation links a child to its parent via --parent", async () => {
    const { cli } = colony();
    const a = cli("agent");
    await a.run(["publish", "root", "{}"]);
    const root = lastJSON(a.lines).id;
    await a.run(["publish", "child", "{}", "--parent", root]);
    const child = lastJSON(a.lines).id;
    a.lines.length = 0;
    await a.run(["causation", child]);
    expect(lastJSON(a.lines).chain).toEqual([root, child]);
  });

  it("--subject and --ref set relational keys", async () => {
    const { cli } = colony();
    const a = cli("agent");
    await a.run(["publish", "note", "{}", "--subject", "grp-1", "--ref", "about=deadbeef"]);
    await a.run(["read", "--type", "note"]);
    const f = JSON.parse(a.lines[a.lines.length - 1]);
    expect(f.refs.subject).toBe("grp-1");
    expect(f.refs.about).toBe("deadbeef");
  });

  it("two observers corroborating reach consensus", async () => {
    const { cli } = colony();
    const author = cli("author");
    await author.run(["publish", "obs", "{}"]);
    const id = lastJSON(author.lines).id;
    expect(await cli("r1").run(["observe", id, "corroborate"])).toBe(0);
    expect(await cli("r2").run(["observe", id, "corroborate"])).toBe(0);
    const probe = cli("probe");
    await probe.run(["trust", id]);
    expect(lastJSON(probe.lines)).toEqual({ trust: "consensus" });
  });

  it("observe rejects a bad verdict", async () => {
    const { cli } = colony();
    const a = cli("agent");
    await a.run(["publish", "x", "{}"]);
    const id = lastJSON(a.lines).id;
    expect(await a.run(["observe", id, "maybe"])).toBe(1);
  });

  it("a losing claimant is told it did not win (exit 1)", async () => {
    const { cli } = colony();
    const alice = cli("alice");
    await alice.run(["publish", "task", "{}"]);
    const id = lastJSON(alice.lines).id;
    expect(await alice.run(["claim", id])).toBe(0);
    const bob = cli("bob");
    expect(await bob.run(["claim", id])).toBe(1); // lost → non-zero
    expect(lastJSON(bob.lines)).toMatchObject({ won: false, winner: "alice" });
  });
});
