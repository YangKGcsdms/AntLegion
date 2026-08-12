import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig, resolveWatchRoot, dcuWorkspaceRoot,
  DEFAULT_WATCH_ROOTS, DEFAULT_BUS_URL,
} from "../src/config.js";

const tmps: string[] = [];
async function tmpConfig(content: unknown): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "ant-config-"));
  tmps.push(d);
  const p = path.join(d, "ant.config.json");
  await fs.writeFile(p, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  return p;
}
afterEach(async () => {
  while (tmps.length) await fs.rm(tmps.pop()!, { recursive: true, force: true });
  delete process.env.ANTLEGION_BUS_URL;
});

describe("loadConfig watchRoots", () => {
  it("loads an explicit watchRoots array with origins", async () => {
    const p = await tmpConfig({
      busUrl: "http://localhost:28090",
      watchRoots: [
        { root: "dcu-workspace", origin: "dcu" },
        { root: "/somewhere/oa/需求工作区", origin: "oa" },
      ],
    });
    const cfg = await loadConfig(p);
    expect(cfg.busUrl).toBe("http://localhost:28090");
    expect(cfg.watchRoots).toHaveLength(2);
    expect(cfg.watchRoots[1]).toEqual({ root: "/somewhere/oa/需求工作区", origin: "oa" });
  });

  it("defaults to the native dcu-workspace ONLY when watchRoots is missing/empty", async () => {
    const p = await tmpConfig({ busUrl: "http://localhost:28090" });
    const cfg = await loadConfig(p);
    expect(cfg.watchRoots).toEqual(DEFAULT_WATCH_ROOTS);
    expect(cfg.watchRoots).toEqual([{ root: "dcu-workspace", origin: "dcu" }]);
    // notably: the OA mirror is NOT in the defaults
    expect(cfg.watchRoots.some((w) => w.origin === "oa")).toBe(false);

    const p2 = await tmpConfig({ busUrl: "http://localhost:28090", watchRoots: [] });
    expect((await loadConfig(p2)).watchRoots).toEqual(DEFAULT_WATCH_ROOTS);
  });

  it("rejects malformed watchRoots entries", async () => {
    await expect(loadConfig(await tmpConfig({
      busUrl: "x", watchRoots: [{ root: "dcu-workspace" }],
    }))).rejects.toThrow(/origin/);
  });
});

describe("loadConfig defaults and env", () => {
  it("a missing config file yields pure defaults", async () => {
    const cfg = await loadConfig("/definitely/not/there/ant.config.json");
    expect(cfg.busUrl).toBe(DEFAULT_BUS_URL);
    expect(cfg.watchRoots).toEqual(DEFAULT_WATCH_ROOTS);
  });

  it("a config file without busUrl falls back to the default bus", async () => {
    const p = await tmpConfig({ watchRoots: [{ root: "w", origin: "dcu" }] });
    expect((await loadConfig(p)).busUrl).toBe(DEFAULT_BUS_URL);
  });

  it("ANTLEGION_BUS_URL overrides both the file and the default", async () => {
    process.env.ANTLEGION_BUS_URL = "http://elsewhere:1234";
    const p = await tmpConfig({ busUrl: "http://localhost:28090" });
    expect((await loadConfig(p)).busUrl).toBe("http://elsewhere:1234");
    expect((await loadConfig("/definitely/not/there/ant.config.json")).busUrl).toBe("http://elsewhere:1234");
  });

  it("the committed ant.config.json points at the repo dcu-workspace", async () => {
    const cfg = await loadConfig(new URL("../ant.config.json", import.meta.url).pathname);
    expect(cfg.watchRoots).toEqual([{ root: "../dcu-workspace", origin: "dcu" }]);
  });
});

describe("resolveWatchRoot / dcuWorkspaceRoot", () => {
  it("resolves relative roots against the cwd, keeps absolutes", () => {
    expect(resolveWatchRoot("dcu-workspace")).toBe(path.resolve(process.cwd(), "dcu-workspace"));
    expect(resolveWatchRoot("/abs/path")).toBe("/abs/path");
  });

  it("dcuWorkspaceRoot picks the dcu-origin entry", async () => {
    const p = await tmpConfig({
      busUrl: "x",
      watchRoots: [
        { root: "/oa", origin: "oa" },
        { root: "dcu-workspace", origin: "dcu" },
      ],
    });
    expect(dcuWorkspaceRoot(await loadConfig(p))).toBe(path.resolve(process.cwd(), "dcu-workspace"));
  });
});
