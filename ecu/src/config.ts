/**
 * config.ts — load ecu.config.json (repo-root relative to this file).
 *
 * New shape (Step 2): the ingestor watches a list of roots, each tagged
 * with an origin. The default — and the only entry in the committed
 * ecu.config.json — is our native dcu-workspace. The old OA mirror root is
 * an optional entry the owner can re-add (see README); it is OFF by default.
 *
 *   {
 *     "busUrl": "http://localhost:28090",
 *     "watchRoots": [{ "root": "dcu-workspace", "origin": "dcu" }]
 *   }
 *
 * `root` may be absolute, or relative to the repo root (ECU_ROOT/..).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WatchRoot {
  /** Absolute path, or repo-root-relative. */
  root: string;
  /** Origin tag carried on every fact mirrored from this root. */
  origin: string;
}

export interface EcuConfig {
  busUrl: string;
  watchRoots: WatchRoot[];
}

export const ECU_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(ECU_ROOT, "..");

/** The native workspace: default (and committed) watch root. */
export const DEFAULT_WATCH_ROOTS: WatchRoot[] = [{ root: "dcu-workspace", origin: "dcu" }];

export async function loadConfig(configPath = path.join(ECU_ROOT, "ecu.config.json")): Promise<EcuConfig> {
  const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as Partial<EcuConfig>;
  if (!raw.busUrl) {
    throw new Error(`ecu.config.json must define busUrl (${configPath})`);
  }
  const watchRoots = raw.watchRoots && raw.watchRoots.length > 0 ? raw.watchRoots : DEFAULT_WATCH_ROOTS;
  for (const w of watchRoots) {
    if (!w.root || !w.origin) {
      throw new Error(`each watchRoots entry needs {root, origin} (${configPath})`);
    }
  }
  return { busUrl: raw.busUrl, watchRoots };
}

/** Resolve a configured root to an absolute path (relative ⇒ repo root). */
export function resolveWatchRoot(root: string): string {
  return path.isAbsolute(root) ? root : path.resolve(REPO_ROOT, root);
}

/** The first dcu-origin root — where `req new` creates requirements. */
export function dcuWorkspaceRoot(cfg: EcuConfig): string {
  const dcu = cfg.watchRoots.find((w) => w.origin === "dcu") ?? cfg.watchRoots[0]!;
  return resolveWatchRoot(dcu.root);
}
