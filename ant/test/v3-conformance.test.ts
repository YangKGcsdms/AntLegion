/**
 * The two places protocol v3.0 changed what a DCU must do.
 *
 * Neither is a type error — both are behaviours that would degrade silently,
 * which is exactly why they are pinned here.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { BusV2 } from "@antlegion/bus/bus";
import { ClientV2, localTransport } from "@antlegion/bus/client";
import type { Fact } from "@antlegion/bus/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptClaimTimeout, type DCUContext } from "../src/runtime.js";
import { buildPromptFile } from "../src/dcus/worker-spawn.js";

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

/** A stub bus that answers /info with whatever the test wants. */
async function stubBus(info: unknown): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === "/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(info));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server!.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

const bareCtx = (): DCUContext => ({
  client: null as never, busUrl: "", mirror: [], log: () => {}, claimTimeout: 600,
});

describe("§8.4 — Δ is the log's, not the reader's", () => {
  it("adopts the Δ the bus publishes", async () => {
    const url = await stubBus({ protocol: "3.0", claim_timeout: 42 });
    const ctx = bareCtx();
    await adoptClaimTimeout(ctx, url, () => {});
    expect(ctx.claimTimeout).toBe(42);
  });

  it("falls back to the §B default and says so when the bus publishes none", async () => {
    const url = await stubBus({ protocol: "3.0" });
    const ctx = bareCtx();
    const logs: string[] = [];
    await adoptClaimTimeout(ctx, url, (m) => logs.push(m));
    expect(ctx.claimTimeout).toBe(600);
    expect(logs.join(" ")).toMatch(/no usable Δ/);
  });

  it("survives an unreachable bus — the DCU loop retries anyway", async () => {
    const ctx = bareCtx();
    const logs: string[] = [];
    await adoptClaimTimeout(ctx, "http://127.0.0.1:1", (m) => logs.push(m));
    expect(ctx.claimTimeout).toBe(600);
    expect(logs.join(" ")).toMatch(/could not read Δ/);
  });

  it("ignores ANT_CLAIM_DELTA and points the operator at the bus", async () => {
    const url = await stubBus({ claim_timeout: 42 });
    const prev = process.env.ANT_CLAIM_DELTA;
    process.env.ANT_CLAIM_DELTA = "7";
    try {
      const ctx = bareCtx();
      const logs: string[] = [];
      await adoptClaimTimeout(ctx, url, (m) => logs.push(m));
      expect(ctx.claimTimeout).toBe(42);           // the bus wins, not the env
      expect(logs.join(" ")).toMatch(/ANT_CLAIM_DELTA is ignored/);
    } finally {
      if (prev === undefined) delete process.env.ANT_CLAIM_DELTA;
      else process.env.ANT_CLAIM_DELTA = prev;
    }
  });
});

describe("§8.2 — a trail gap reaches the prompt as a gap", () => {
  const dir = mkdtempSync(join(tmpdir(), "ant-v3-"));

  function promptFor(mirror: Fact[], input: Fact): string {
    return buildPromptFile({
      stage: "dev", req: { slug: "s", name: "n" },
      spec: { listens: [], produces: [], evidence: { required: { out: "the artifact" } } } as never,
      inputFact: input, colonyRoot: dir, cfg: {} as never, claimDeltaSec: 600,
      ctx: { client: null as never, busUrl: "", mirror, log: () => {}, claimTimeout: 600 },
    }, "/tmp/artifact.json");
  }

  it("renders an unresolved ancestor instead of dropping it", () => {
    const bus = new BusV2({ dataDir: join(dir, ".d1"), fsync: "no", secret: "t" });
    // parent names a fact this DCU has never seen — the ordinary case for a
    // colony that joined late or reads a filtered window.
    const r = bus.append({ type: "dev.requested", author: "a", ts: 1, refs: { parent: "0".repeat(64) } });
    const mirror = [...bus.all()] as Fact[];
    const prompt = promptFor(mirror, bus.get(r.id)!);
    expect(prompt).toContain("000000000000");
    expect(prompt).toMatch(/不完整|不要当作起点/);
    bus.close();
  });

  it("renders a fully resolvable chain without a gap line", () => {
    const bus = new BusV2({ dataDir: join(dir, ".d2"), fsync: "no", secret: "t" });
    const root = bus.append({ type: "req.registered", author: "a", ts: 1 });
    const child = bus.append({ type: "dev.requested", author: "a", ts: 2, refs: { parent: root.id } });
    const mirror = [...bus.all()] as Fact[];
    const prompt = promptFor(mirror, bus.get(child.id)!);
    expect(prompt).toContain("req.registered");
    expect(prompt).not.toMatch(/不要当作起点/);
    bus.close();
  });
});
