/**
 * Entry point: start the antlegion-bus HTTP server.
 *
 * The bus is a passive state store. Clients drive their own polling loop
 * via GET /facts?since_sequence=N. There is no event push.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./server/app.js";
import { DEFAULT_CONFIG } from "./types/protocol.js";

const port = parseInt(process.env.PORT ?? String(DEFAULT_CONFIG.server.port), 10);
const host = process.env.HOST ?? DEFAULT_CONFIG.server.host;
const dataDir = process.env.ANTLEGION_DATA_DIR ?? DEFAULT_CONFIG.data.dir;

const { app, engine } = createApp({ data: { dir: dataDir } });

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[antlegion-bus] listening on http://${host}:${info.port}`);
});

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[antlegion-bus] ${signal} received, shutting down...`);
    engine.shutdown();
    server.close();
    process.exit(0);
  });
}
