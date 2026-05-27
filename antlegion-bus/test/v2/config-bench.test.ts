import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/v2/config.js";
import { runBench } from "../../src/v2/bench.js";

describe("R4 — config (the redis.conf analog)", () => {
  it("sane defaults from empty env", () => {
    const c = loadConfig({});
    expect(c).toEqual({ port: 28090, dataDir: ".data-v2", fsync: "everysec", secret: undefined });
  });

  it("env overrides are honored", () => {
    const c = loadConfig({
      PORT: "9000",
      ANTLEGION_DATA_DIR: "/data",
      ANTLEGION_FSYNC: "always",
      ANTLEGION_BUS_SECRET: "s3cret",
    });
    expect(c).toEqual({ port: 9000, dataDir: "/data", fsync: "always", secret: "s3cret" });
  });

  it("an invalid fsync value falls back to everysec", () => {
    expect(loadConfig({ ANTLEGION_FSYNC: "bogus" }).fsync).toBe("everysec");
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
