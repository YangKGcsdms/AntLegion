/**
 * s2ext-lib.ts — shared plumbing for the S2 extended rounds (评估宪章
 * .cowork/11-隔离协作评估指标.md M5/M6/M8 的扩展实验):
 *
 *   exp2-repeat.ts     — M6 崩溃接管时延分布（N 次 kill -9 重复轮）
 *   exp5-clock-skew.ts — M5 时钟偏移容忍（ts 拨快/拨慢 ±5min 三臂对照）
 *   exp8-repeat.ts     — M8 伪造报告拦截率稳定性（N 轮重复）
 *
 * Deliberately self-contained (small duplication with m1m3-lib.ts instead of
 * importing it — that file belongs to a concurrently-running experiment line
 * and must not become a shared dependency). All runs: simulated act, no API
 * key, no docker; buses live on the 29xxx port range with tmp data dirs that
 * are removed after a successful run.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Fact } from "@antlegion/bus/types";
import type { Transport } from "@antlegion/bus/client";

export const ANT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TSX_CLI = path.join(ANT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
export const BUS_ENTRY = path.join(ANT_ROOT, "node_modules", "@antlegion", "bus", "dist", "index.js");
export const RESULTS_DIR = path.join(ANT_ROOT, "experiments", "results");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function mkRunDir(tag: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `s2ext-${tag}-`));
}

/**
 * Spawn the bus (plain compiled JS — no tsx needed), logging to a file.
 * `detached` puts every child in its own process group (see killTree).
 */
export async function spawnBus(
  port: number, dataDir: string, logFile: string,
): Promise<ChildProcess> {
  const out = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [BUS_ENTRY], {
    cwd: ANT_ROOT,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      ANTLEGION_DATA_DIR: dataDir,
      ANTLEGION_FSYNC: "no", // durability is not under test in any of these rounds
      ANTLEGION_BUS_SECRET: "s2ext-extended-rounds",
    },
    stdio: ["ignore", out.fd, out.fd],
  });
  child.on("spawn", () => void out.close());
  return child;
}

/**
 * Spawn a .ts helper through the package-local tsx, logging to a file.
 *
 * IMPORTANT: the tsx CLI is a *wrapper* — it runs the script in a child node
 * process of its own. A SIGKILL aimed at the wrapper pid would leave the real
 * worker process alive (SIGKILL cannot be forwarded — that is its point), so
 * every child is spawned `detached` into its own process group and killed via
 * killTree(), which signals the whole group. This is what makes the M6 round's
 * `kill -9` genuinely kill the node, not the wrapper.
 */
export async function spawnTsx(
  script: string, env: Record<string, string>, logFile: string,
): Promise<ChildProcess> {
  const out = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [TSX_CLI, script], {
    cwd: ANT_ROOT,
    detached: true,
    env: { ...process.env, ANT_WORKER: "simulated", ...env },
    stdio: ["ignore", out.fd, out.fd],
  });
  child.on("spawn", () => void out.close());
  return child;
}

/** Signal a child's entire process group (wrapper + real worker). */
export function killTree(c: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (typeof c.pid === "number") {
    try { process.kill(-c.pid, signal); return; } catch { /* group already gone */ }
  }
  try { c.kill(signal); } catch { /* already gone */ }
}

export async function waitHealth(busUrl: string, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${busUrl}/health`); if (r.ok) return; } catch { /* not yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`bus at ${busUrl} failed to come up in ${timeoutMs}ms`);
    await sleep(200);
  }
}

export async function readAll(t: Transport): Promise<Fact[]> {
  const facts: Fact[] = [];
  let cursor = 0;
  for (;;) {
    const page = await t.read({ since: cursor, limit: 500 });
    if (page.length === 0) break;
    for (const f of page) { facts.push(f); if (f.seq > cursor) cursor = f.seq; }
    if (page.length < 500) break;
  }
  return facts;
}

export function killAll(children: ChildProcess[]): void {
  for (const c of children) killTree(c, "SIGKILL");
}

/** Nearest-rank percentile over an unsorted sample (p in [0,100]). */
export function percentile(sample: readonly number[], p: number): number {
  if (sample.length === 0) return NaN;
  const s = [...sample].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

export function dist(sample: readonly number[]): { min: number; p50: number; p95: number; max: number; mean: number } {
  const s = [...sample].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { min: s[0] ?? NaN, p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1] ?? NaN, mean };
}

export async function writeResults(basename: string, payload: unknown): Promise<string> {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stamped = path.join(RESULTS_DIR, `${basename}-${stamp}.json`);
  await fs.writeFile(stamped, JSON.stringify(payload, null, 2));
  await fs.writeFile(path.join(RESULTS_DIR, `${basename}-latest.json`), JSON.stringify(payload, null, 2));
  return stamped;
}

export const fmt = (n: number, digits = 2): string => (Number.isFinite(n) ? n.toFixed(digits) : "—");
