import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig, resolveWatchRoot, dcuWorkspaceRoot,
  DEFAULT_WATCH_ROOTS, REPO_ROOT,
} from "../src/config.js";

const tmps: string[] = [];
async function tmpConfig(content: unknown): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "ecu-config-"));
  tmps.push(d);
  const p = path.join(d, "ecu.config.json");
  await fs.writeFile(p, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  return p;
}
afterEach(async () => {
  while (tmps.length) await fs.rm(tmps.pop()!, { recursive: true, force: true });
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

  it("rejects configs without busUrl or with malformed watchRoots entries", async () => {
    await expect(loadConfig(await tmpConfig({ watchRoots: [] }))).rejects.toThrow(/busUrl/);
    await expect(loadConfig(await tmpConfig({
      busUrl: "x", watchRoots: [{ root: "dcu-workspace" }],
    }))).rejects.toThrow(/origin/);
  });

  it("the committed ecu.config.json defaults to our native workspace only", async () => {
    const cfg = await loadConfig(); // real ecu/ecu.config.json
    expect(cfg.watchRoots).toEqual([{ root: "dcu-workspace", origin: "dcu" }]);
  });
});

describe("resolveWatchRoot / dcuWorkspaceRoot", () => {
  it("resolves relative roots against the repo root, keeps absolutes", () => {
    expect(resolveWatchRoot("dcu-workspace")).toBe(path.join(REPO_ROOT, "dcu-workspace"));
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
    expect(dcuWorkspaceRoot(await loadConfig(p))).toBe(path.join(REPO_ROOT, "dcu-workspace"));
  });
});
