/**
 * spawn-act tests (计划 13 §二): the headless-agent act contract.
 *
 * Integration runs a REAL child process (test/fixtures/fake-agent.mjs)
 * against an in-process BusV2 via localTransport — claim, overlapping-
 * re-claim renewal, resolve/release/act.failed all exercise the same §3.1
 * folds production uses.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BusV2 } from "@antlegion/bus/bus";
import { ClientV2, localTransport } from "@antlegion/bus/client";
import { lifecycle } from "@antlegion/bus/fold";
import type { Fact } from "@antlegion/bus/types";
import {
  ACT_FAILED, buildPromptFile, buildSpawnEnv, expandTemplate, runSpawnAct,
  tail, validateSpawnArtifact,
} from "../src/dcus/worker-spawn.js";
import { colonyAuthor } from "../src/config.js";
import { DEVCHAIN, foldDevchain } from "../src/folds/devchain.js";
import { declaredProduces, inClaimScope } from "../src/dcus/devchain-dcus.js";
import type { DCUContext } from "../src/runtime.js";

const FIXTURE = path.join(__dirname, "fixtures", "fake-agent.mjs");

// ── pure helpers ──

describe("expandTemplate", () => {
  it("substitutes known vars and leaves unknown braces alone", () => {
    expect(expandTemplate("run {cmd} in {cwd} at {nope}", { cmd: "x", cwd: "/tmp" }))
      .toBe("run x in /tmp at {nope}");
  });
});

describe("buildSpawnEnv", () => {
  it("passes defaults + explicit names, never the blocklist", () => {
    const base = {
      PATH: "/bin", HOME: "/me", FOO: "bar",
      ANTLEGION_BUS_SECRET: "s3cret", LARK_WEBHOOK: "hook", DEEPSEEK_API_KEY: "k",
    };
    const env = buildSpawnEnv(base, ["FOO", "ANTLEGION_BUS_SECRET", "LARK_WEBHOOK"]);
    expect(env.PATH).toBe("/bin");
    expect(env.FOO).toBe("bar");
    // blocklist wins even when explicitly listed (计划 13 §二.6)
    expect(env.ANTLEGION_BUS_SECRET).toBeUndefined();
    expect(env.LARK_WEBHOOK).toBeUndefined();
    // not listed → not passed
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });
});

describe("validateSpawnArtifact", () => {
  it("accepts the full shape", () => {
    expect(validateSpawnArtifact({
      summary: "s", changes: [], test_status: "ok", not_done: ["x"],
    })).toEqual([]);
  });
  it("requires not_done to be non-empty — 没做什么是必填", () => {
    expect(validateSpawnArtifact({ summary: "s", changes: [], test_status: "ok", not_done: [] }))
      .toContain("not_done");
  });
  it("flags every missing field", () => {
    expect(validateSpawnArtifact({})).toEqual(["summary", "changes", "test_status", "not_done"]);
  });
  it("rejects non-objects", () => {
    expect(validateSpawnArtifact("nope")).toEqual(["(not a JSON object)"]);
  });
});

describe("tail", () => {
  it("keeps only the end", () => {
    expect(tail("abcdef", 3)).toBe("def");
    expect(tail("ab", 3)).toBe("ab");
  });
});

describe("colonyAuthor", () => {
  it("rewrites the suffix when a colony is set", () => {
    expect(colonyAuthor("dcu-dev@devchain", "projA")).toBe("dcu-dev@projA");
  });
  it("keeps legacy authors untouched without a colony", () => {
    expect(colonyAuthor("dcu-dev@devchain")).toBe("dcu-dev@devchain");
    expect(colonyAuthor("dcu-dev@devchain", undefined)).toBe("dcu-dev@devchain");
  });
});

describe("inClaimScope", () => {
  const req = { origin: "projA", reqFact: { payload: { repo: "projA", meta: { team: "ops" } } } };
  it("open scope claims everything", () => {
    expect(inClaimScope(req)).toBe(true);
    expect(inClaimScope(req, {})).toBe(true);
  });
  it("origins gate", () => {
    expect(inClaimScope(req, { origins: ["projA"] })).toBe(true);
    expect(inClaimScope(req, { origins: ["projB"] })).toBe(false);
  });
  it("structured filter walks dot-paths (never JSON substring matching)", () => {
    expect(inClaimScope(req, { filter: { path: "repo", eq: "projA" } })).toBe(true);
    expect(inClaimScope(req, { filter: { path: "meta.team", eq: "ops" } })).toBe(true);
    expect(inClaimScope(req, { filter: { path: "meta.team", eq: "dev" } })).toBe(false);
    expect(inClaimScope(req, { filter: { path: "missing.deep", eq: 1 } })).toBe(false);
  });
});

describe("declaredProduces", () => {
  it("folds the latest registry per author, both produces and publishes shapes", () => {
    const facts = [
      { type: "sys.registry", author: "a@x", seq: 1, payload: { produces: ["t1"] } },
      { type: "sys.registry", author: "a@x", seq: 5, payload: { produces: ["t2"] } },
      { type: "sys.registry", author: "b@x", seq: 2, payload: { publishes: "t3" } },
      { type: "other", author: "c@x", seq: 3, payload: { produces: ["zzz"] } },
    ];
    const m = declaredProduces(facts);
    expect(m.get("a@x")?.has("t2")).toBe(true);
    expect(m.get("a@x")?.has("t1")).toBe(false); // superseded by the later declaration
    expect(m.get("b@x")?.has("t3")).toBe(true);
    expect(m.has("c@x")).toBe(false);
  });
});

// ── integration: real child process against an in-process bus ──

describe("runSpawnAct", () => {
  let dir: string;
  let bus: BusV2;
  let client: ClientV2;
  let logs: string[];

  const AUTHOR = "dcu-dev@testcol";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-act-"));
    bus = new BusV2({ dataDir: path.join(dir, ".data"), fsync: "no", secret: "test" });
    client = new ClientV2(localTransport(bus), AUTHOR, { claimTimeout: 600 });
    logs = [];
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ctx = (): DCUContext => ({
    client, busUrl: "local", mirror: [...bus.all()] as Fact[],
    log: (m) => logs.push(m),
  });

  /** Seed a trigger fact, claim it as AUTHOR, return the fact. */
  async function seedAndClaim(): Promise<Fact> {
    const r = bus.append({
      type: "plan.ready", author: "dcu-plan@testcol", ts: 1,
      payload: { reqSlug: "r1", scope: "do the thing" },
    });
    const c = await client.claim(r.id);
    expect(c.won).toBe(true);
    return bus.get(r.id)!;
  }

  function actArgs(inputFact: Fact, cmdMode: string, over: Partial<Parameters<typeof runSpawnAct>[0]> = {}) {
    return {
      stage: "dev",
      spec: DEVCHAIN.dev,
      req: { slug: "r1", name: "需求一" },
      inputFact,
      ctx: ctx(),
      colonyRoot: dir,
      cfg: {
        cmd: `node ${FIXTURE} {promptFile} {artifactFile} ${cmdMode}`,
        artifact: "dcu-workspace/{req}/{stage}.out.json",
        timeoutSec: 30,
      },
      claimDeltaSec: 600,
      ...over,
    };
  }

  it("exit 0 + valid artifact → resolve with the artifact as child fact", async () => {
    const input = await seedAndClaim();
    await runSpawnAct(actArgs(input, "ok"));

    const all = [...bus.all()] as Fact[];
    expect(lifecycle(all, input.id).state).toBe("resolved");
    const artifact = all.find((f) => f.type === "dev.done");
    expect(artifact).toBeDefined();
    expect(artifact!.refs.parent).toBe(input.id);
    expect(artifact!.payload.generator).toBe("spawn");
    expect(artifact!.payload.not_done).toEqual(["did not touch the legacy import path"]);
    // prompt file existed and carried the contract (agent read it)
    expect(artifact!.payload.prompt_bytes).toBeGreaterThan(100);
  });

  it("exit ≠ 0 → release + act.failed with stderr tail", async () => {
    const input = await seedAndClaim();
    await runSpawnAct(actArgs(input, "fail"));

    const all = [...bus.all()] as Fact[];
    expect(lifecycle(all, input.id).state).toBe("open"); // released — others can take it
    const failed = all.find((f) => f.type === ACT_FAILED);
    expect(failed).toBeDefined();
    expect(failed!.refs.subject).toBe(input.id);
    expect(String(failed!.payload.stderr_tail)).toContain("boom");
    expect(failed!.payload.exit_code).toBe(1);
  });

  it("invalid artifact shape → act.failed listing the missing fields", async () => {
    const input = await seedAndClaim();
    await runSpawnAct(actArgs(input, "bad"));

    const all = [...bus.all()] as Fact[];
    expect(lifecycle(all, input.id).state).toBe("open");
    const failed = all.find((f) => f.type === ACT_FAILED);
    expect(failed!.payload.missing).toContain("not_done");
    expect(all.find((f) => f.type === "dev.done")).toBeUndefined();
  });

  it("timeout → SIGTERM + act.failed(timeout)", async () => {
    const input = await seedAndClaim();
    await runSpawnAct(actArgs(input, "ok 10000", { cfg: {
      cmd: `node ${FIXTURE} {promptFile} {artifactFile} ok 10000`,
      artifact: "dcu-workspace/{req}/{stage}.out.json",
      timeoutSec: 1,
    } }));

    const all = [...bus.all()] as Fact[];
    const failed = all.find((f) => f.type === ACT_FAILED);
    expect(failed).toBeDefined();
    expect(String(failed!.payload.reason)).toContain("timeout");
  }, 15_000);

  it("renewal heartbeat: a task longer than Δ keeps the claim via overlapping re-claims", async () => {
    // Δ = 2s, agent takes ~5s. Without renewal the claim would be long dead
    // at resolve time; with Δ/3 re-claims the same author stays the winner.
    const shortClient = new ClientV2(localTransport(bus), AUTHOR, { claimTimeout: 2 });
    const r = bus.append({
      type: "plan.ready", author: "dcu-plan@testcol", ts: 1,
      payload: { reqSlug: "r1", scope: "slow work" },
    });
    const c = await shortClient.claim(r.id);
    expect(c.won).toBe(true);
    const input = bus.get(r.id)!;

    await runSpawnAct(actArgs(input, "ok 5000", {
      ctx: { client: shortClient, busUrl: "local", mirror: [...bus.all()] as Fact[], log: (m) => logs.push(m) },
      claimDeltaSec: 2,
    }));

    const all = [...bus.all()] as Fact[];
    expect(lifecycle(all, input.id, { claimTimeout: 2 }).state).toBe("resolved");
    expect(all.find((f) => f.type === "dev.done")).toBeDefined();
    // overlapping re-claims actually happened (≥ 2 claims by the author, no release)
    const claims = all.filter((f) => f.refs.claim_of === input.id && f.author === AUTHOR);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(all.find((f) => f.refs.release_of === input.id)).toBeUndefined();
  }, 20_000);

  it("prompt file carries trigger payload, causation, artifact contract and evidence fields", async () => {
    const input = await seedAndClaim();
    const args = actArgs(input, "ok");
    const artifactFile = path.join(dir, "dcu-workspace/r1/dev.out.json");
    const prompt = buildPromptFile(args, artifactFile);
    expect(prompt).toContain("do the thing");           // trigger payload
    expect(prompt).toContain("plan.ready");             // causation line
    expect(prompt).toContain(artifactFile);             // artifact contract
    expect(prompt).toContain("not_done");               // base shape
    expect(prompt).toContain("consumers_checked");      // dev-stage evidence field
    expect(prompt).toContain(".ant/memory/");           // working memory
  });
});
