/**
 * init.ts — `ant init`: a guided setup that ends in ./ant.config.json.
 *
 * Asks only what the daemon actually needs: where the bus is, where the
 * workspace lives, how acts run (llm | simulated), and whether human gates
 * auto-approve. Secrets are NEVER written to the config — the DeepSeek key
 * stays in the DEEPSEEK_API_KEY environment variable.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { DEFAULT_BUS_URL, antDir, type AntConfig } from "./config.js";

async function probeBus(url: string): Promise<string> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return `reachable but unhealthy (${res.status})`;
    const j = (await res.json()) as { head_seq?: number };
    return `up — head_seq ${j.head_seq ?? "?"}`;
  } catch {
    return "not reachable (start one with: npx @antlegion/bus)";
  }
}

export async function runInit(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // EOF-safe: piped/non-TTY stdin may close early — fall back to the default.
  const ask = async (q: string, dflt: string): Promise<string> => {
    try {
      const a = (await rl.question(`${q} ${dflt ? `[${dflt}] ` : ""}`)).trim();
      return a || dflt;
    } catch {
      console.log(`${q} → ${dflt} (stdin closed, using default)`);
      return dflt;
    }
  };

  console.log("ant init — resident DCU fleet setup (writes ./ant.config.json)\n");

  const busUrl = await ask("bus URL?", process.env.ANTLEGION_BUS_URL || DEFAULT_BUS_URL);
  console.log(`  bus: ${await probeBus(busUrl)}`);

  // colony identity (计划 13): the folder IS the colony; its name suffixes
  // every DCU author (dcu-dev@{colony}) and scopes what this ant claims.
  const colonyDflt = path.basename(process.cwd()).replace(/[^A-Za-z0-9_-]/g, "-") || "colony";
  const colony = await ask("colony name (author suffix; empty = legacy @devchain)?", colonyDflt);

  const workspace = await ask("requirement workspace (created if missing)?", "dcu-workspace");

  const hasKey = !!process.env.DEEPSEEK_API_KEY;
  const workerDflt = hasKey ? "llm" : "simulated";
  let worker = (await ask(`act mode — spawn (headless agent), llm (DeepSeek), or simulated?`, workerDflt)).toLowerCase();
  if (worker !== "llm" && worker !== "simulated" && worker !== "spawn") worker = workerDflt;

  let model = "deepseek-v4-flash";
  let spawnCmd = "";
  if (worker === "llm") {
    model = await ask("model id?", process.env.ANT_LLM_MODEL || "deepseek-v4-flash");
    console.log(hasKey
      ? "  DEEPSEEK_API_KEY: found in environment ✓ (never written to the config)"
      : "  DEEPSEEK_API_KEY: NOT set — export it before `ant start`, or acts will fail");
  } else if (worker === "spawn") {
    spawnCmd = await ask("agent command ({promptFile}/{artifactFile}/{cwd} are substituted)?",
      "claude -p {promptFile}");
    console.log("  the agent runs INSIDE this folder; artifacts land in the workspace");
  }

  const gateAns = (await ask("auto-approve human gates (unattended runs)? y/N", "N")).toLowerCase();
  const autoGate = gateAns === "y" || gateAns === "yes";

  rl.close();

  const cfg: AntConfig = {
    busUrl,
    watchRoots: [{ root: workspace, origin: colony || "dcu" }],
    worker: worker as "llm" | "simulated" | "spawn",
    ...(worker === "llm" ? { model } : {}),
    ...(worker === "spawn" ? {
      spawn: {
        cmd: spawnCmd,
        cwd: ".",
        timeoutSec: 1800,
        artifact: `${workspace}/{req}/{stage}.out.json`,
      },
    } : {}),
    autoGate,
    ...(colony ? { identity: { colony, origins: [colony] } } : {}),
  };
  const file = path.join(process.cwd(), "ant.config.json");
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  await fs.mkdir(path.resolve(process.cwd(), workspace), { recursive: true });
  // colony residency: pid/logs/prompts + the agent's cross-wake working memory
  await fs.mkdir(path.join(antDir(), "memory"), { recursive: true });

  console.log(`\nwrote ${file}`);
  console.log(`\nnext steps:`);
  console.log(`  ant start                          # the fleet wakes up and waits for facts`);
  console.log(`  ant start --daemon                 # …or resident in the background (see ant status)`);
  console.log(`  ant req new "试点需求" -s pilot      # feed it work`);
  console.log(`  ant board                          # watch it on http://localhost:28091/devchain.html`);
}
