/**
 * config.ts — load ecu.config.json (repo-root relative to this file).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EcuConfig {
  busUrl: string;
  oaRoot: string;
  reqWorkspace: string;
}

export const ECU_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function loadConfig(configPath = path.join(ECU_ROOT, "ecu.config.json")): Promise<EcuConfig> {
  const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as Partial<EcuConfig>;
  if (!raw.busUrl || !raw.oaRoot || !raw.reqWorkspace) {
    throw new Error(`ecu.config.json must define busUrl, oaRoot, reqWorkspace (${configPath})`);
  }
  return { busUrl: raw.busUrl, oaRoot: raw.oaRoot, reqWorkspace: raw.reqWorkspace };
}

export function reqWorkspaceRoot(cfg: EcuConfig): string {
  return path.join(cfg.oaRoot, cfg.reqWorkspace);
}
