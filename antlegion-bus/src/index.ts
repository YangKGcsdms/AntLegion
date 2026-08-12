#!/usr/bin/env node
/**
 * v2 entry point — boot the append-only fact bus over HTTP.
 *
 *   PORT=28090 ANTLEGION_BUS_SECRET=... node dist/index.js
 *   npx @antlegion/bus demo    → the three-act killer demo (src/demo.ts)
 *
 * The server is the trusted core (§0.2): assign order, verify, stamp+sign,
 * persist, serve a range. All coordination semantics live in the client SDK
 * (client.ts) as reader folds.
 */

import { serve } from "@hono/node-server";
import { createServerV2 } from "./server.js";
import { loadConfig } from "./config.js";

// `antlegion demo` — the three-act demo instead of a server. Everything else
// (no arg, or unknown args) boots the bus, preserving `npx @antlegion/bus`.
if (process.argv[2] === "demo") {
  const { runDemo } = await import("./demo.js");
  await runDemo(); // never returns
}

const cfg = loadConfig();

const { app, bus } = createServerV2({ dataDir: cfg.dataDir, fsync: cfg.fsync, secret: cfg.secret, maxDepth: cfg.maxDepth });

const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  console.log(`[antlegion-v2] append-only fact bus on http://${cfg.host}:${info.port} (fsync=${cfg.fsync})`);
  console.log(`[antlegion-v2] dashboard → http://${cfg.host}:${info.port}/dashboard`);
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
    console.log(`[antlegion-v2] listening beyond loopback (HOST=${cfg.host}) — the bus trusts its callers; keep it inside your trust boundary`);
  }
});

// Human-grade startup failure: a busy port gets one clear line, not a stack trace.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`error: port ${cfg.port} already in use — is another bus running?`);
  } else {
    console.error(`error: ${err.message}`);
  }
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[antlegion-v2] ${sig} — flushing + shutting down`);
    bus.close();   // flush the AOF before exit
    server.close();
    process.exit(0);
  });
}
