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
import { devchainFleet, stageDCU } from "./dcus/devchain-dcus.js";
import { STAGES } from "./folds/devchain.js";
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

/**
 * Run the dev-chain fleet in one process (each DCU its own identity/loop).
 * `--dcus plan,dev` runs a subset — that is how the fleet spreads across
 * containers/machines while staying one fleet on one bus.
 */
async function runChain(): Promise<void> {
  const args = process.argv.slice(3);
  let dcus: string[] | null = null;
  let replica = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dcus") dcus = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (args[i] === "--replica") replica = parseInt(args[++i] ?? "0", 10) || 0;
  }
  const cfg = await loadConfig();
  const root = dcuWorkspaceRoot(cfg);
  const autoGate = process.env.ANT_AUTO_GATE === "1" || (dcus?.includes("gate") ?? false);
  const stageOpts = {
    ...(cfg.identity ? { identity: cfg.identity } : {}),
    ...(cfg.spawn ? { spawn: cfg.spawn } : {}),
  };
  // --replica N shifts stage identities (dcu-plan-rN…) so a second process
  // joins the same bus as a SIBLING, never as a same-identity twin.
  let fleet = replica > 0
    ? [...STAGES.map((s) => stageDCU(s, cfg.busUrl, root, replica, stageOpts))]
    : devchainFleet(cfg.busUrl, root, { autoGate, ...stageOpts });
  if (dcus) {
    fleet = fleet.filter((spec) => {
      const short = spec.name.split("@")[0]!; // e.g. dcu-plan
      return dcus.some((k) => short.includes(k));
    });
    if (fleet.length === 0) {
      console.error(`--dcus matched nothing (known: plan, dev, unittest, e2e, adjudicator, watchdog, gate)`);
      process.exit(2);
    }
    console.error(`[chain] running subset: ${fleet.map((s) => s.name).join(", ")}`);
  }
  await Promise.all(fleet.map((spec) => runDCU(spec)));
}

/**
 * `ant start` — the resident colony, driven by ./ant.config.json (see
 * `ant init`): fleet + ingestor, worker mode / model / auto-gate from
 * config (env vars still win). Crash-safe by construction: a claim held
 * by a dead unit expires on bus time and a sibling re-wins it.
 */
async function runStart(): Promise<void> {
  const cfg = await loadConfig();
  // config → env, so worker code (which reads env at act time) follows it
  if (cfg.worker && !process.env.ANT_WORKER) process.env.ANT_WORKER = cfg.worker;
  if (cfg.model && !process.env.ANT_LLM_MODEL) process.env.ANT_LLM_MODEL = cfg.model;
  if (process.env.ANT_WORKER === "llm" && !process.env.DEEPSEEK_API_KEY) {
    console.error("error: worker mode is llm but DEEPSEEK_API_KEY is not set — export it or set worker to simulated");
    process.exit(1);
  }
  if (process.env.ANT_WORKER === "spawn" && !cfg.spawn) {
    console.error("error: worker mode is spawn but the config has no spawn block — see ant init");
    process.exit(1);
  }
  const autoGate = process.env.ANT_AUTO_GATE === "1" || (cfg.autoGate ?? false);
  const root = dcuWorkspaceRoot(cfg);
  const colony = cfg.identity?.colony;
  console.error(`[start] bus ${cfg.busUrl} · worker ${process.env.ANT_WORKER ?? "simulated"} · autoGate ${autoGate} · workspace ${root}${colony ? ` · colony ${colony}` : ""}`);

  const fleet = devchainFleet(cfg.busUrl, root, {
    autoGate,
    ...(cfg.identity ? { identity: cfg.identity } : {}),
    ...(cfg.spawn ? { spawn: cfg.spawn } : {}),
    ...(cfg.heartbeatSec !== undefined ? { heartbeatSec: cfg.heartbeatSec } : {}),
  });
  if (cfg.schedules && cfg.schedules.length > 0) {
    const { schedulerDCU } = await import("./dcus/scheduler-dcu.js");
    fleet.push(schedulerDCU(cfg.busUrl, cfg.schedules, cfg.identity));
  }
  const loops = fleet.map((spec) => runDCU(spec));
  loops.push(runIngestor()); // mirror the workspace so req dirs/docs become facts
  await Promise.all(loops);
  // Loops are done (SIGTERM/SIGINT drained) but the ingestor's fs.watch and
  // rescan timers still hold the event loop — exit explicitly so `ant stop`
  // (SIGTERM from the daemon) actually terminates the colony.
  process.exit(0);
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

const HELP = `ant — resident agents (DCUs) on the AntLegion shared world-state log

usage: ant <command>

  chain [--dcus a,b]          run the dev-chain DCU fleet (4 stage DCUs +
                              adjudicator + watchdog); --dcus runs a subset —
                              spread one fleet across containers/machines
  ingestor                    mirror configured workspace roots onto the bus
  board                       serve the supervision board (http://localhost:28091)
  req new "<名称>" [-s slug]  create a requirement in dcu-workspace and
                              publish req.registered
  mvp [--reqs N] [--no-fleet] unattended throughput run: fleet + auto-gate +
                              N requirements (default 25 → 100 stage cycles);
                              ANT_WORKER=llm routes acts through DeepSeek;
                              --no-fleet feeds/scores an external fleet

  init                        guided setup → ./ant.config.json (bus URL,
                              workspace, act mode llm|simulated|spawn,
                              colony identity, auto-gate)
  start                       resident colony from the config: fleet +
                              workspace ingestor (+ scheduler if configured);
                              wakes on facts, sleeps after
  start --daemon              detach the colony; pid/log → ./.ant/
  stop | status | logs [-f]   manage the detached colony
  launchd                     print a launchd plist (macOS boot autostart)

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
  case "init":
    import("./init.js")
      .then((m) => m.runInit())
      .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
    break;
  case "start":
    if (process.argv.includes("--daemon")) {
      import("./daemon.js")
        .then((m) => m.startDaemon()).then((code) => process.exit(code))
        .catch((err) => { console.error(err); process.exit(1); });
    } else {
      runStart().catch((err) => { console.error(err); process.exit(1); });
    }
    break;
  case "stop":
    import("./daemon.js").then((m) => m.stopDaemon()).then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case "status":
    import("./daemon.js").then((m) => m.statusDaemon()).then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case "logs":
    import("./daemon.js").then((m) => m.logsDaemon(process.argv.includes("-f")))
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case "launchd":
    import("./daemon.js").then((m) => m.printLaunchd()).then((code) => process.exit(code))
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
