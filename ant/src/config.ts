/**
 * config.ts — load ant.config.json from the current working directory.
 *
 * The ingestor watches a list of roots, each tagged with an origin. With no
 * config file at all, sensible defaults apply: the bus on localhost:28090
 * (or ANTLEGION_BUS_URL) and a ./dcu-workspace next to where you ran `ant`.
 *
 *   {
 *     "busUrl": "http://localhost:28090",
 *     "watchRoots": [{ "root": "dcu-workspace", "origin": "dcu" }]
 *   }
 *
 * Precedence for busUrl: ANTLEGION_BUS_URL > ant.config.json > default.
 * `root` may be absolute, or relative to the working directory.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WatchRoot {
  /** Absolute path, or cwd-relative. */
  root: string;
  /** Origin tag carried on every fact mirrored from this root. */
  origin: string;
}

/** Colony identity (计划 13 §三). All optional — absent keeps legacy behavior. */
export interface IdentityConfig {
  /** Colony name → author suffix: dcu-dev@devchain becomes dcu-dev@{colony}. */
  colony?: string;
  /** Only claim work whose req fact carries one of these origin tags. */
  origins?: string[];
  /** Structured claim-side predicate on the trigger fact's payload
   * (NOT a JSON substring match — key order / nesting would break that). */
  filter?: { path: string; eq: unknown };
}

/** Headless-agent act (计划 13 §二). Template vars in `cmd`:
 * {cwd} {promptFile} {artifactFile} {req} {stage}. */
export interface SpawnConfig {
  /** e.g. "claude -p {promptFile}" / "pi --cwd {cwd} -p {promptFile}". */
  cmd: string;
  /** Working dir for the child; relative ⇒ colony root. Default ".". */
  cwd?: string;
  /** Hard kill after this many seconds (default 1800). */
  timeoutSec?: number;
  /** Artifact contract path (template vars {req} {stage}); relative ⇒ colony root. */
  artifact: string;
  /** Extra env var NAMES passed through to the child (whitelist additions).
   * ANTLEGION_BUS_SECRET and LARK_* are never passed, even if listed. */
  envPass?: string[];
}

/** scheduler DCU entry (计划 13 §四): publish a fact on a cron beat. */
export interface ScheduleEntry {
  /** Stable name — part of the deterministic nonce. */
  name: string;
  /** Five-field cron: "min hour dom mon dow" — numbers, wildcard, step (slash-n), lists, ranges. */
  cron: string;
  type: string;
  payload?: Record<string, unknown>;
}

export interface AntConfig {
  busUrl: string;
  watchRoots: WatchRoot[];
  /** Act mode for stage workers (ant start): "llm" routes acts through the
   * configured model via pi-ai; "simulated" needs no key; "spawn" wakes a
   * headless agent in the colony folder. Env ANT_WORKER wins. */
  worker?: "llm" | "simulated" | "spawn";
  /** Model id for llm acts (default deepseek-v4-flash). Env ANT_LLM_MODEL wins. */
  model?: string;
  /** Auto-approve human gates (unattended). Env ANT_AUTO_GATE wins. */
  autoGate?: boolean;
  identity?: IdentityConfig;
  spawn?: SpawnConfig;
  schedules?: ScheduleEntry[];
  /** sys.heartbeat interval (default 20s; conflict window = 2×). 0 disables. */
  heartbeatSec?: number;
}

/** Package root (board.html and friends live here) — works from src/ and dist/. */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_BUS_URL = "http://localhost:28090";

/** The native workspace: default watch root. */
export const DEFAULT_WATCH_ROOTS: WatchRoot[] = [{ root: "dcu-workspace", origin: "dcu" }];

const envBusUrl = (): string | undefined => process.env.ANTLEGION_BUS_URL || undefined;

export async function loadConfig(configPath = path.join(process.cwd(), "ant.config.json")): Promise<AntConfig> {
  let raw: Partial<AntConfig>;
  try {
    raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as Partial<AntConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No config file — pure defaults.
      return { busUrl: envBusUrl() ?? DEFAULT_BUS_URL, watchRoots: DEFAULT_WATCH_ROOTS };
    }
    throw err;
  }
  // Guard against a JSON that parses but isn't an object (null / array / scalar):
  // a bare `null` would otherwise throw a cryptic TypeError on `raw.watchRoots`
  // (review L5). Fall back to defaults with a clear message instead.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${configPath} must contain a JSON object (got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw})`);
  }
  const watchRoots = raw.watchRoots && raw.watchRoots.length > 0 ? raw.watchRoots : DEFAULT_WATCH_ROOTS;
  for (const w of watchRoots) {
    if (!w.root || !w.origin) {
      throw new Error(`each watchRoots entry needs {root, origin} (${configPath})`);
    }
  }
  if (raw.identity?.colony !== undefined) {
    const c = raw.identity.colony;
    if (typeof c !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(c)) {
      throw new Error(`identity.colony must match [A-Za-z0-9][A-Za-z0-9_-]* (${configPath})`);
    }
  }
  if (raw.worker === "spawn") {
    if (!raw.spawn?.cmd || !raw.spawn?.artifact) {
      throw new Error(`worker "spawn" needs spawn.{cmd, artifact} (${configPath})`);
    }
  }
  for (const s of raw.schedules ?? []) {
    if (!s.name || !s.cron || !s.type) {
      throw new Error(`each schedules entry needs {name, cron, type} (${configPath})`);
    }
  }
  return {
    busUrl: envBusUrl() ?? raw.busUrl ?? DEFAULT_BUS_URL,
    watchRoots,
    ...(raw.worker === "llm" || raw.worker === "simulated" || raw.worker === "spawn" ? { worker: raw.worker } : {}),
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
    ...(typeof raw.autoGate === "boolean" ? { autoGate: raw.autoGate } : {}),
    ...(raw.identity ? { identity: raw.identity } : {}),
    ...(raw.spawn ? { spawn: raw.spawn } : {}),
    ...(raw.schedules ? { schedules: raw.schedules } : {}),
    ...(typeof raw.heartbeatSec === "number" ? { heartbeatSec: raw.heartbeatSec } : {}),
  };
}

/**
 * Rewrite an author's colony suffix: colonyAuthor("dcu-dev@devchain", "projA")
 * → "dcu-dev@projA". No colony (or no "@") ⇒ unchanged — full back-compat.
 */
export function colonyAuthor(base: string, colony?: string): string {
  if (!colony) return base;
  const at = base.indexOf("@");
  return at === -1 ? `${base}@${colony}` : `${base.slice(0, at)}@${colony}`;
}

/** Colony residency dir (pid, logs, prompts, agent working memory). */
export function antDir(): string {
  return path.join(process.cwd(), ".ant");
}

/** Resolve a configured root to an absolute path (relative ⇒ cwd). */
export function resolveWatchRoot(root: string): string {
  return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
}

/** The first dcu-origin root — where `req new` creates requirements. */
export function dcuWorkspaceRoot(cfg: AntConfig): string {
  const dcu = cfg.watchRoots.find((w) => w.origin === "dcu") ?? cfg.watchRoots[0]!;
  return resolveWatchRoot(dcu.root);
}
