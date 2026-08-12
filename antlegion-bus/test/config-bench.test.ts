import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { runBench } from "../src/bench.js";

describe("R4 — config (the redis.conf analog)", () => {
  it("sane defaults from empty env", () => {
    const c = loadConfig({});
    expect(c).toEqual({ port: 28090, host: "127.0.0.1", dataDir: ".data-v2", fsync: "everysec", secret: undefined, maxDepth: 64 });
  });

  it("env overrides are honored", () => {
    const c = loadConfig({
      PORT: "9000",
      HOST: "0.0.0.0",
      ANTLEGION_DATA_DIR: "/data",
      ANTLEGION_FSYNC: "always",
      ANTLEGION_BUS_SECRET: "s3cret",
      ANTLEGION_MAX_DEPTH: "128",
    });
    expect(c).toEqual({ port: 9000, host: "0.0.0.0", dataDir: "/data", fsync: "always", secret: "s3cret", maxDepth: 128 });
  });

  it("an invalid fsync value falls back to everysec", () => {
    expect(loadConfig({ ANTLEGION_FSYNC: "bogus" }).fsync).toBe("everysec");
  });

  it("an invalid max-depth falls back to 64", () => {
    expect(loadConfig({ ANTLEGION_MAX_DEPTH: "0" }).maxDepth).toBe(64);
    expect(loadConfig({ ANTLEGION_MAX_DEPTH: "nope" }).maxDepth).toBe(64);
  });
});

describe("R6 — benchmark (the redis-benchmark analog)", () => {
  it("reports throughput and is infra-grade fast", () => {
    const r = runBench({ n: 3000, fsync: "no" });
    expect(r.n).toBe(3000);
    expect(r.fsync).toBe("no");
    // very conservative floors — real numbers are far higher; this just proves
    // the path is in the "thousands+/s" infra ballpark, not seconds-per-op.
    expect(r.appendPerSec).toBeGreaterThan(1000);
    expect(r.readPerSec).toBeGreaterThan(1000);
  });
});
