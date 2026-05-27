/**
 * v2 server configuration (the `redis.conf` analog), resolved from env.
 *
 *   PORT                  default 28090
 *   ANTLEGION_DATA_DIR    default .data-v2
 *   ANTLEGION_FSYNC       always | everysec | no   (default everysec)
 *   ANTLEGION_BUS_SECRET  stable HMAC secret (recommended; random if unset)
 */

import type { FsyncPolicy } from "./log.js";

export interface V2Config {
  port: number;
  dataDir: string;
  fsync: FsyncPolicy;
  secret?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): V2Config {
  const f = env.ANTLEGION_FSYNC;
  const fsync: FsyncPolicy = f === "always" || f === "everysec" || f === "no" ? f : "everysec";
  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 28090,
    dataDir: env.ANTLEGION_DATA_DIR ?? ".data-v2",
    fsync,
    secret: env.ANTLEGION_BUS_SECRET,
  };
}
