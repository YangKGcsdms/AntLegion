/**
 * v2 server configuration (the `redis.conf` analog), resolved from env.
 *
 *   PORT                  default 28090
 *   HOST                  default 127.0.0.1 — the bus trusts its callers
 *                         (Redis-shaped: bind to loopback unless you mean it)
 *   ANTLEGION_DATA_DIR    default .data-v2
 *   ANTLEGION_FSYNC       always | everysec | no   (default everysec)
 *   ANTLEGION_BUS_SECRET  stable HMAC secret (recommended; random if unset)
 *   ANTLEGION_MAX_DEPTH   causation depth cap (§5, default 64)
 */

import type { FsyncPolicy } from "./log.js";

export interface V2Config {
  port: number;
  host: string;
  dataDir: string;
  fsync: FsyncPolicy;
  secret?: string;
  maxDepth: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): V2Config {
  const f = env.ANTLEGION_FSYNC;
  const fsync: FsyncPolicy = f === "always" || f === "everysec" || f === "no" ? f : "everysec";
  const d = env.ANTLEGION_MAX_DEPTH ? parseInt(env.ANTLEGION_MAX_DEPTH, 10) : NaN;
  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 28090,
    host: env.HOST || "127.0.0.1",
    dataDir: env.ANTLEGION_DATA_DIR ?? ".data-v2",
    fsync,
    secret: env.ANTLEGION_BUS_SECRET,
    maxDepth: Number.isInteger(d) && d > 0 ? d : 64,
  };
}
