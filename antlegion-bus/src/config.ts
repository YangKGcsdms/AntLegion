/**
 * v2 server configuration (the `redis.conf` analog), resolved from env.
 *
 *   PORT                  default 28090
 *   HOST                  default 127.0.0.1 — the bus trusts its callers
 *                         (Redis-shaped: bind to loopback unless you mean it)
 *   ANTLEGION_DATA_DIR    default .data-v2
 *   ANTLEGION_FSYNC       always | everysec | no   (default everysec)
 *   ANTLEGION_BUS_SECRET  stable HMAC secret (recommended; random if unset)
 *   ANTLEGION_MAX_DEPTH   causation depth cap (§10.2, default 64)
 *   ANTLEGION_CLAIM_TIMEOUT  Δ in seconds (§8.4/§B, default 600)
 *
 * Δ is here because §8.4 makes it a property of the LOG: the bus publishes it
 * and every reader MUST fold with the published value. Without this knob the
 * only way to run a log with a different Δ was to edit the source, which made
 * "a property of the log" true in the spec and false at the command line.
 */

import type { FsyncPolicy } from "./log.js";

export interface V2Config {
  port: number;
  host: string;
  dataDir: string;
  fsync: FsyncPolicy;
  secret?: string;
  maxDepth: number;
  claimTimeout: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): V2Config {
  const f = env.ANTLEGION_FSYNC;
  const fsync: FsyncPolicy = f === "always" || f === "everysec" || f === "no" ? f : "everysec";
  const d = env.ANTLEGION_MAX_DEPTH ? parseInt(env.ANTLEGION_MAX_DEPTH, 10) : NaN;
  const delta = env.ANTLEGION_CLAIM_TIMEOUT ? parseFloat(env.ANTLEGION_CLAIM_TIMEOUT) : NaN;
  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 28090,
    host: env.HOST || "127.0.0.1",
    dataDir: env.ANTLEGION_DATA_DIR ?? ".data-v2",
    fsync,
    secret: env.ANTLEGION_BUS_SECRET,
    maxDepth: Number.isInteger(d) && d > 0 ? d : 64,
    claimTimeout: Number.isFinite(delta) && delta > 0 ? delta : 600,
  };
}
