/**
 * daemon.ts — run a colony like you run redis-server (计划 13 §四).
 *
 *   ant start --daemon   spawn a detached `ant start`, pid/log → ./.ant/
 *   ant stop             SIGTERM the pidfile's process
 *   ant status           pid alive? + bus reachability + where things live
 *   ant logs [-f]        tail the colony log
 *   ant launchd          print a launchd plist (macOS auto-start on boot)
 *
 * Ported from antlegion-bus/src/daemon.ts. Everything lives under the
 * colony's .ant/ — one directory per colony, next to ant.config.json.
 */

import { spawn } from "node:child_process";
import { promises as fs, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { antDir, loadConfig } from "./config.js";

const PIDFILE = () => path.join(antDir(), "ant.pid");
const LOGFILE = () => path.join(antDir(), "ant.log");

async function alivePid(): Promise<number | null> {
  try {
    const pid = parseInt(await fs.readFile(PIDFILE(), "utf-8"), 10);
    if (!Number.isInteger(pid)) return null;
    process.kill(pid, 0); // throws if gone
    return pid;
  } catch { return null; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The built CLI entry (dist/main.js) — what the detached child re-runs. */
function cliEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
}

export async function startDaemon(): Promise<number> {
  const existing = await alivePid();
  if (existing) {
    console.error(`already running (pid ${existing}) — see ant status`);
    return 1;
  }
  const cfg = await loadConfig(); // fail fast on a broken config, before detaching
  await fs.mkdir(antDir(), { recursive: true });
  const log = openSync(LOGFILE(), "a");
  const child = spawn(process.execPath, [cliEntry(), "start"], {
    detached: true,
    stdio: ["ignore", log, log],
    cwd: process.cwd(),          // the colony root anchors everything
    env: process.env,
  });
  child.unref();
  await fs.writeFile(PIDFILE(), String(child.pid), "utf-8");

  // "started" = still alive after a beat (the fleet has no HTTP surface of its own)
  await sleep(1200);
  if (!(await alivePid())) {
    console.error(`colony died on boot — check ${LOGFILE()}`);
    return 1;
  }
  console.log(`[ant] colony started (pid ${child.pid})`);
  console.log(`[ant] bus     ${cfg.busUrl}`);
  console.log(`[ant] log     ${LOGFILE()}`);
  console.log(`[ant] stop with: ant stop`);
  return 0;
}

export async function stopDaemon(): Promise<number> {
  const pid = await alivePid();
  if (!pid) {
    console.error(`not running (no live pid at ${PIDFILE()})`);
    return 1;
  }
  process.kill(pid, "SIGTERM"); // runDCU loops stop after the current batch
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (!(await alivePid())) {
      await fs.rm(PIDFILE(), { force: true });
      console.log(`[ant] stopped (pid ${pid})`);
      return 0;
    }
  }
  console.error(`pid ${pid} did not exit within 5s — a spawn act may be draining; retry or inspect`);
  return 1;
}

export async function statusDaemon(): Promise<number> {
  const pid = await alivePid();
  const cfg = await loadConfig();
  let bus = "NOT RESPONDING";
  try {
    const r = await fetch(`${cfg.busUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) bus = JSON.stringify(await r.json());
  } catch { /* stays NOT RESPONDING */ }
  if (!pid) {
    console.log(`stopped · start with: ant start --daemon`);
    console.log(`bus       ${cfg.busUrl} → ${bus}`);
    return 1;
  }
  console.log(`pid       ${pid}`);
  console.log(`colony    ${cfg.identity?.colony ?? "(default devchain)"} · worker ${cfg.worker ?? "simulated"}`);
  console.log(`bus       ${cfg.busUrl} → ${bus}`);
  console.log(`log       ${LOGFILE()}`);
  return 0;
}

export async function logsDaemon(follow: boolean): Promise<number> {
  try {
    await fs.stat(LOGFILE());
  } catch {
    console.error(`no log yet at ${LOGFILE()}`);
    return 1;
  }
  if (follow) {
    const t = spawn("tail", ["-f", LOGFILE()], { stdio: "inherit" });
    await new Promise((res) => t.on("exit", res));
    return 0;
  }
  const text = await fs.readFile(LOGFILE(), "utf-8");
  const lines = text.split("\n");
  console.log(lines.slice(Math.max(0, lines.length - 100)).join("\n"));
  return 0;
}

/** Print a launchd plist — pipe to ~/Library/LaunchAgents/ for boot autostart. */
export async function printLaunchd(): Promise<number> {
  const cfg = await loadConfig();
  const label = `com.antlegion.ant.${cfg.identity?.colony ?? path.basename(process.cwd())}`;
  console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliEntry()}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${process.cwd()}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOGFILE()}</string>
  <key>StandardErrorPath</key><string>${LOGFILE()}</string>
</dict>
</plist>`);
  console.error(`\n# install:  ant launchd > ~/Library/LaunchAgents/${label}.plist && launchctl load ~/Library/LaunchAgents/${label}.plist`);
  return 0;
}
