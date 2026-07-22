/**
 * main.ts — CLI entry:
 *
 *   tsx src/main.ts ingestor                    watch configured roots → bus
 *   tsx src/main.ts board                       serve board.html (:28091)
 *   tsx src/main.ts req new "<名称>" [-s slug]  create a native requirement
 *                                               in dcu-workspace + publish
 *                                               req.registered (origin dcu)
 */

import { httpTransport } from "antlegion-bus/client";
import { loadConfig, resolveWatchRoot, dcuWorkspaceRoot, ECU_ROOT } from "./config.js";
import { runDCU } from "./runtime.js";
import { AUTHOR, backfill, newKnownState, startWatcher } from "./dcus/ingestor-req.js";
import { createBoardServer } from "./board.js";
import { createRequirement } from "./req-new.js";

const cmd = process.argv[2];

async function runIngestor(): Promise<void> {
  const cfg = await loadConfig();
  const publisher = httpTransport(cfg.busUrl);
  const log = (m: string) => console.error(`[ingestor-req] ${new Date().toISOString()} ${m}`);

  const roots = cfg.watchRoots.map((w) => ({ ...w, abs: resolveWatchRoot(w.root) }));
  for (const w of roots) log(`watch root: ${w.abs} (origin=${w.origin}, READ-ONLY)`);

  await runDCU({
    name: "ingestor-req",
    author: AUTHOR,
    busUrl: cfg.busUrl,
    pollMs: 1000,
    init: async () => {
      // Cold-start backfill per root: publish everything; bus dedups on reruns.
      // Each root gets its own KnownState, so steady-state rescans only hit
      // the bus when something actually changed on disk.
      for (const w of roots) {
        const known = newKnownState();
        const stats = await backfill(w.abs, publisher, log, known, w.origin);
        log(
          `[${w.origin}] cold-start backfill: +${stats.reqsPublished} req (${stats.reqsDeduped} deduped), ` +
          `+${stats.docsPublished} docs (${stats.docsDeduped} deduped), ${stats.errors} errors`,
        );
        // Steady state: fs.watch + 5s rescan fallback, incremental via known state.
        startWatcher(w.abs, publisher, log, 5000, known, w.origin);
      }
      log(`watching ${roots.length} root(s) (fs.watch + 5s rescan fallback)`);
    },
  });
}

async function runBoard(): Promise<void> {
  const cfg = await loadConfig();
  const port = process.env.BOARD_PORT ? parseInt(process.env.BOARD_PORT, 10) : 28091;
  createBoardServer(cfg.busUrl, port);
  console.log(`[board] serving ${ECU_ROOT} — Ctrl+C to stop`);
}

/** req new "<名称>" [-s slug] — native requirement creation (origin dcu). */
async function runReqNew(): Promise<void> {
  const args = process.argv.slice(3);
  if (args[0] !== "new") {
    console.error('usage: tsx src/main.ts req new "<名称>" [-s slug]');
    process.exit(2);
  }
  let name: string | undefined;
  let slug: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-s") {
      slug = args[++i];
    } else if (name === undefined) {
      name = args[i];
    } else {
      console.error(`unexpected argument: ${args[i]}`);
      process.exit(2);
    }
  }
  if (!name) {
    console.error('usage: tsx src/main.ts req new "<名称>" [-s slug]');
    process.exit(2);
  }

  const cfg = await loadConfig();
  const root = dcuWorkspaceRoot(cfg);
  const result = await createRequirement(root, name, slug !== undefined ? { slug } : {});

  // Publish req.registered. The nonce (req:dcu:<dirname>) and payload are
  // identical to what the ingestor's backfill plans for the same dir, so
  // whoever publishes second dedups — no double-publish, ever.
  let publishNote: string;
  try {
    const publisher = httpTransport(cfg.busUrl);
    const r = await publisher.append(result.fact);
    publishNote = r.deduped
      ? `req.registered deduped on bus (seq ${r.seq})`
      : `req.registered published → seq ${r.seq}`;
  } catch (err) {
    publishNote = `bus unreachable (${err instanceof Error ? err.message : String(err)}) — ` +
      `the running ingestor will mirror this dir with the same nonce`;
  }

  console.log(`${result.existed ? "exists" : "created"} ${result.dir}`);
  console.log(publishNote);
}

switch (cmd) {
  case "ingestor":
    runIngestor().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "board":
    runBoard().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "req":
    runReqNew().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
    break;
  default:
    console.error('usage: tsx src/main.ts ingestor|board|req new "<名称>" [-s slug]');
    process.exit(2);
}
