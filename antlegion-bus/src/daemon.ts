/**
 * daemon.ts — run the bus like you run redis-server.
 *
 *   antlegion start     spawn a detached bus, write pidfile, wait for /health
 *   antlegion stop      SIGTERM the pidfile's process (journal flushes on exit)
 *   antlegion status    pid alive? + /health + where the log/journal live
 *
 * Everything lives under the data dir (default .data-v2/): the journal, the
 * pidfile, and the log — one directory to back up, one to delete.
 */

import { spawn } from "node:child_process";
import { promises as fs, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const DATA = path.resolve(cfg.dataDir);
const PIDFILE = path.join(DATA, "antlegion.pid");
const LOGFILE = path.join(DATA, "antlegion.log");
const URL = `http://${cfg.host}:${cfg.port}`;

async function alivePid(): Promise<number | null> {
  try {
    const pid = parseInt(await fs.readFile(PIDFILE, "utf-8"), 10);
    if (!Number.isInteger(pid)) return null;
    process.kill(pid, 0); // throws if gone
    return pid;
  } catch { return null; }
}

async function health(): Promise<{ ok: boolean; body?: unknown }> {
  try {
    const r = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(1500) });
    return { ok: r.ok, body: await r.json() };
  } catch { return { ok: false }; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function start(): Promise<number> {
  const existing = await alivePid();
  if (existing) {
    console.error(`already running (pid ${existing}) — ${URL}`);
    return 1;
  }
  await fs.mkdir(DATA, { recursive: true });
  const log = openSync(LOGFILE, "a");
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env, // PORT/HOST/ANTLEGION_* pass straight through
  });
  child.unref();
  await fs.writeFile(PIDFILE, String(child.pid), "utf-8");

  for (let i = 0; i < 20; i++) { // up to ~5s for first boot / journal replay
    await sleep(250);
    const h = await health();
    if (h.ok) {
      console.log(`[antlegion] started (pid ${child.pid})`);
      console.log(`[antlegion] bus       ${URL}`);
      console.log(`[antlegion] console   ${URL}/console`);
      console.log(`[antlegion] journal   ${path.join(DATA, "facts-v2.jsonl")}`);
      console.log(`[antlegion] log       ${LOGFILE}`);
      console.log(`[antlegion] stop with: antlegion stop`);
      if (!process.env.ANTLEGION_BUS_SECRET) {
        console.log(`[antlegion] note: no ANTLEGION_BUS_SECRET set — sigs won't verify across restarts`);
      }
      return 0;
    }
  }
  console.error(`bus did not become healthy within 5s — check ${LOGFILE}`);
  return 1;
}

export async function stop(): Promise<number> {
  const pid = await alivePid();
  if (!pid) {
    console.error(`not running (no live pid at ${PIDFILE})`);
    return 1;
  }
  process.kill(pid, "SIGTERM"); // index.ts flushes the journal on SIGTERM
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (!(await alivePid())) {
      await fs.rm(PIDFILE, { force: true });
      console.log(`[antlegion] stopped (pid ${pid}) — journal flushed`);
      return 0;
    }
  }
  console.error(`pid ${pid} did not exit within 4s — inspect it before using kill -9 (journal safety)`);
  return 1;
}

export async function status(): Promise<number> {
  const pid = await alivePid();
  const h = await health();
  if (!pid && !h.ok) {
    console.log(`stopped · start with: antlegion start`);
    return 1;
  }
  console.log(`pid       ${pid ?? `— (no pidfile, but something answers on ${URL})`}`);
  console.log(`health    ${h.ok ? JSON.stringify(h.body) : "NOT RESPONDING"}`);
  console.log(`bus       ${URL} · console ${URL}/console`);
  console.log(`journal   ${path.join(DATA, "facts-v2.jsonl")}`);
  console.log(`log       ${LOGFILE}`);
  return h.ok ? 0 : 1;
}
