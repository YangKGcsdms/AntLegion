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

export interface AntConfig {
  busUrl: string;
  watchRoots: WatchRoot[];
  /** Act mode for stage workers (ant start): "llm" routes acts through the
   * configured model via pi-ai; "simulated" needs no key. Env ANT_WORKER wins. */
  worker?: "llm" | "simulated";
  /** Model id for llm acts (default deepseek-v4-flash). Env ANT_LLM_MODEL wins. */
  model?: string;
  /** Auto-approve human gates (unattended). Env ANT_AUTO_GATE wins. */
  autoGate?: boolean;
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
  return {
    busUrl: envBusUrl() ?? raw.busUrl ?? DEFAULT_BUS_URL,
    watchRoots,
    ...(raw.worker === "llm" || raw.worker === "simulated" ? { worker: raw.worker } : {}),
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
    ...(typeof raw.autoGate === "boolean" ? { autoGate: raw.autoGate } : {}),
  };
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
