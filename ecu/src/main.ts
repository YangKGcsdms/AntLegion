/**
 * main.ts — CLI entry: `tsx src/main.ts ingestor|board`
 */

import { httpTransport } from "antlegion-bus/client";
import { loadConfig, reqWorkspaceRoot, ECU_ROOT } from "./config.js";
import { runDCU } from "./runtime.js";
import { AUTHOR, backfill, newKnownState, startWatcher } from "./dcus/ingestor-req.js";
import { createBoardServer } from "./board.js";

const cmd = process.argv[2];

async function runIngestor(): Promise<void> {
  const cfg = await loadConfig();
  const root = reqWorkspaceRoot(cfg);
  const publisher = httpTransport(cfg.busUrl);
  const log = (m: string) => console.error(`[ingestor-req] ${new Date().toISOString()} ${m}`);

  log(`workspace: ${root} (READ-ONLY)`);

  await runDCU({
    name: "ingestor-req",
    author: AUTHOR,
    busUrl: cfg.busUrl,
    pollMs: 1000,
    init: async () => {
      // Cold-start backfill: publish everything; bus dedups on reruns.
      // The watcher shares the same KnownState, so steady-state rescans only
      // hit the bus when something actually changed on disk.
      const known = newKnownState();
      const stats = await backfill(root, publisher, log, known);
      log(
        `cold-start backfill: +${stats.reqsPublished} req (${stats.reqsDeduped} deduped), ` +
        `+${stats.docsPublished} docs (${stats.docsDeduped} deduped), ${stats.errors} errors`,
      );
      // Steady state: fs.watch + 5s rescan fallback, incremental via known state.
      startWatcher(root, publisher, log, 5000, known);
      log(`watching (fs.watch + 5s rescan fallback)`);
    },
  });
}

async function runBoard(): Promise<void> {
  const cfg = await loadConfig();
  const port = process.env.BOARD_PORT ? parseInt(process.env.BOARD_PORT, 10) : 28091;
  createBoardServer(cfg.busUrl, port);
  console.log(`[board] serving ${ECU_ROOT} — Ctrl+C to stop`);
}

switch (cmd) {
  case "ingestor":
    runIngestor().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "board":
    runBoard().catch((err) => { console.error(err); process.exit(1); });
    break;
  default:
    console.error("usage: tsx src/main.ts ingestor|board");
    process.exit(2);
}
