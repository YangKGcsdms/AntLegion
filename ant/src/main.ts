#!/usr/bin/env node
/**
 * main.ts — the `ant` CLI:
 *
 *   ant chain                       run the dev-chain DCU fleet
 *                                   (4 stage DCUs + adjudicator + watchdog)
 *   ant ingestor                    watch configured roots → bus
 *   ant board                       serve the supervision board (:28091)
 *   ant req new "<名称>" [-s slug]  create a native requirement in
 *                                   dcu-workspace + publish req.registered
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { httpTransport } from "@antlegion/bus/client";
import { loadConfig, resolveWatchRoot, dcuWorkspaceRoot, PKG_ROOT } from "./config.js";
import { runDCU } from "./runtime.js";
import { AUTHOR, backfill, newKnownState, startWatcher } from "./dcus/ingestor-req.js";
import { devchainFleet } from "./dcus/devchain-dcus.js";
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

/** Run the whole dev-chain fleet in one process (each DCU its own identity/loop). */
async function runChain(): Promise<void> {
  const cfg = await loadConfig();
  const root = dcuWorkspaceRoot(cfg);
  const autoGate = process.env.ANT_AUTO_GATE === "1";
  await Promise.all(devchainFleet(cfg.busUrl, root, { autoGate }).map((spec) => runDCU(spec)));
}

async function runBoard(): Promise<void> {
  const cfg = await loadConfig();
  const port = process.env.BOARD_PORT ? parseInt(process.env.BOARD_PORT, 10) : 28091;
  createBoardServer(cfg.busUrl, port);
  console.log(`[board] serving ${PKG_ROOT} — Ctrl+C to stop`);
}

/** req new "<名称>" [-s slug] — native requirement creation (origin dcu). */
async function runReqNew(): Promise<void> {
  const args = process.argv.slice(3);
  if (args[0] !== "new") {
    console.error('usage: ant req new "<名称>" [-s slug]');
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
    console.error('usage: ant req new "<名称>" [-s slug]');
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

const HELP = `ant — autonomous DCUs (Domain Control Units) on the AntLegion fact bus

usage: ant <command>

  chain                       run the dev-chain DCU fleet
                              (4 stage DCUs + adjudicator + watchdog)
  ingestor                    mirror configured workspace roots onto the bus
  board                       serve the supervision board (http://localhost:28091)
  req new "<名称>" [-s slug]  create a requirement in dcu-workspace and
                              publish req.registered
  mvp [--reqs N]              unattended throughput run: fleet + auto-gate +
                              N requirements (default 25 → 100 stage cycles);
                              ANT_WORKER=llm routes acts through DeepSeek

  init / start                guided setup + resident daemon — coming in 0.2

config: ./ant.config.json (optional; sensible defaults apply)
env:    ANTLEGION_BUS_URL (default http://localhost:28090) · BOARD_PORT (28091)
docs:   https://github.com/YangKGcsdms/antlegion-platform`;

async function printVersion(): Promise<void> {
  const pkg = JSON.parse(await fsp.readFile(path.join(PKG_ROOT, "package.json"), "utf-8")) as { version: string };
  console.log(pkg.version);
}

switch (cmd) {
  case "ingestor":
    runIngestor().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "board":
    runBoard().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "chain":
    runChain().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "req":
    runReqNew().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
    break;
  case "mvp":
    import("./mvp.js")
      .then((m) => m.runMvp(process.argv.slice(3)))
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case "--version":
  case "-v":
    printVersion().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "--help":
  case "-h":
  case "help":
  case undefined:
    console.log(HELP);
    process.exit(cmd === undefined ? 2 : 0);
    break;
  default:
    console.error(`unknown command: ${cmd}\n\n${HELP}`);
    process.exit(2);
}
