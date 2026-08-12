/**
 * THE KILLER DEMO — AntLegion vs. message queues, mailbox coordinators, and
 * in-process agent frameworks. Three acts, three punchlines, zero locks.
 *
 *   ACT 1 · THE RACE   — 8 independent agent processes from 4 "frameworks"
 *                        race to claim several hundred tasks off one bus.
 *                        Duplicates are counted live: the answer is 0, not
 *                        because of a lock, but as a theorem of total order
 *                        (lowest-seq live claim wins, PROTOCOL.md §3.1).
 *
 *   ACT 2 · THE CRASH  — one agent is genuinely SIGKILLed mid-run while
 *                        holding claims. No orchestrator notices; the bus-
 *                        stamped recv clock expires the stale claims and the
 *                        survivors re-claim and finish every one.
 *
 *   ACT 3 · THE REPLAY — the bus itself is killed and restarted from its
 *                        journal (facts-v2.jsonl). The reconstructed stream
 *                        is verified byte-identical: same head_seq, same
 *                        facts, same owner/state for every task. Nothing
 *                        external to sync — the log IS the state.
 *
 * Run:  npx @antlegion/bus demo   (or `antlegion demo` when installed globally)
 *
 * Env knobs:
 *   ANTLEGION_DEMO_PORT      fixed port (default: ephemeral) — use 28090 with
 *                            demo/dashboard.html for the live dashboard combo
 *   ANTLEGION_DEMO_DATA_DIR  journal dir (default: mktemp, deleted after run)
 *   ANTLEGION_DEMO_SECRET    HMAC secret (default: "demo-killer")
 *   ANTLEGION_DEMO_TASKS     task count (default: 400)
 *   ANTLEGION_DEMO_DELTA     claim timeout seconds (default: 3)
 *   ANTLEGION_DEMO_FSYNC     always | everysec | no (default: always)
 *   ANTLEGION_DEMO_KEEP_BUS  "1" → after ACT 3, leave a replayed bus running
 *                            on the port for the dashboard, then exit 0
 *   ANTLEGION_DEMO_VERBOSE   "1" → stream child-process logs
 */

import { serve } from "@hono/node-server";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerV2 } from "./server.js";
import { ClientV2, httpTransport } from "./client.js";
import type { Fact } from "./types.js";
import { foldTasks, type TaskView } from "./demo-worker.js";

// ─────────────────────────────── configuration ───────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "demo-worker.js"); // compiled sibling — no tsx, plain node fork

const FIXED_PORT = parseInt(process.env.ANTLEGION_DEMO_PORT ?? "0", 10);
const OWN_DIR = !process.env.ANTLEGION_DEMO_DATA_DIR;
const DATA_DIR = process.env.ANTLEGION_DEMO_DATA_DIR ?? mkdtempSync(join(tmpdir(), "antlegion-killer-"));
const SECRET = process.env.ANTLEGION_DEMO_SECRET ?? "demo-killer";
const TOTAL = parseInt(process.env.ANTLEGION_DEMO_TASKS ?? "400", 10);
const DELTA = parseFloat(process.env.ANTLEGION_DEMO_DELTA ?? "3");
const FSYNC = (process.env.ANTLEGION_DEMO_FSYNC ?? "always") as "always" | "everysec" | "no";
const KEEP_BUS = process.env.ANTLEGION_DEMO_KEEP_BUS === "1";
const VERBOSE = process.env.ANTLEGION_DEMO_VERBOSE === "1";
const KILL_AT = Math.floor(TOTAL * 0.4); // pull the trigger at 40% resolved

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ─────────────────────────────── presentation ────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const noColor = !!process.env.NO_COLOR;
const c = (col: keyof typeof C, s: string) => (noColor ? s : `${C[col]}${s}${C.reset}`);

function banner(title: string, sub: string): void {
  const line = "═".repeat(76);
  console.log(`\n${c("cyan", line)}`);
  console.log(c("bold", `  ${title}`));
  console.log(c("dim", `  ${sub}`));
  console.log(c("cyan", line));
}
function punch(s: string): void {
  console.log(`\n  ${c("yellow", "▸")} ${c("bold", c("yellow", s))}\n`);
}

// ───────────────────────────── bus boot / shutdown ───────────────────────────

interface RunningBus { port: number; close: () => void; closeBus: () => void }

async function tryBootBus(): Promise<RunningBus> {
  const { app, bus } = createServerV2({ secret: SECRET, dataDir: DATA_DIR, fsync: FSYNC });
  let server: { close: () => void; on: (ev: string, fn: (e: Error) => void) => void } | null = null;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: FIXED_PORT }, (i) => resolve(i.port));
      server = s as unknown as NonNullable<typeof server>;
      server.on("error", reject); // async listen errors (EADDRINUSE on fixed-port rebind)
    });
    return { port, close: () => server!.close(), closeBus: () => bus.close() };
  } catch (e) {
    try { bus.close(); } catch { /* nothing to flush */ }
    throw e;
  }
}

/** Boot, retrying briefly — ACT 3 rebinds a fixed port right after the old server closes. */
async function bootBus(): Promise<RunningBus> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await tryBootBus(); }
    catch (e) { lastErr = e; await sleep(400); }
  }
  throw lastErr;
}

// ─────────────────────────────── child processes ─────────────────────────────

interface Agent {
  name: string;
  framework: string;
  mode: "racer" | "victim";
  child: ChildProcess;
  dead: boolean;
  exitSignal: string | null;
  tail: string[];
}

/**
 * Kill the agent's whole process GROUP. Workers are plain forked node
 * processes now, but detached:true still makes each a group leader, so
 * -pid guarantees nothing it spawned survives either.
 */
function killAgent(agent: Agent, signal: NodeJS.Signals): void {
  try {
    if (agent.child.pid) process.kill(-agent.child.pid, signal);
  } catch {
    try { agent.child.kill(signal); } catch { /* already gone */ }
  }
}

function spawnAgent(base: string, name: string, framework: string, mode: "racer" | "victim"): Agent {
  const args = [
    WORKER,
    "--bus", base, "--author", name, "--total", String(TOTAL),
    "--delta", String(DELTA), "--mode", mode,
    "--work-ms", mode === "victim" ? "120" : "35",
    "--batch", "10",
  ];
  const child = fork(WORKER, args, { stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true });
  const agent: Agent = { name, framework, mode, child, dead: false, exitSignal: null, tail: [] };
  const onLine = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      agent.tail.push(line);
      if (agent.tail.length > 20) agent.tail.shift();
      if (VERBOSE) console.log(c("gray", `    ${line}`));
    }
  };
  child.stdout!.on("data", onLine);
  child.stderr!.on("data", onLine);
  child.on("exit", (_code, signal) => { agent.dead = true; agent.exitSignal = signal; });
  return agent;
}

// ─────────────────────────── driver-side stream mirror ───────────────────────

class Mirror {
  facts: Fact[] = [];
  cursor = 0;
  constructor(private readonly client: ClientV2) {}
  async pull(): Promise<void> {
    for (;;) {
      const chunk = await this.client.query({ since: this.cursor, limit: 1000 });
      if (chunk.length === 0) break;
      for (const f of chunk) { this.facts.push(f); if (f.seq > this.cursor) this.cursor = f.seq; }
      if (chunk.length < 1000) break;
    }
  }
}

interface Stats {
  resolved: number; open: number; claimed: number;
  claims: number; races: number; dupes: number; doneFacts: number;
  byOwner: Map<string, number>;
  view: Map<string, TaskView>;
}

function computeStats(view: Map<string, TaskView>): Stats {
  const s: Stats = {
    resolved: 0, open: 0, claimed: 0, claims: 0, races: 0,
    dupes: 0, doneFacts: 0, byOwner: new Map(), view,
  };
  for (const t of view.values()) {
    if (t.state === "resolved") s.resolved++;
    else if (t.state === "claimed") s.claimed++;
    else if (t.state === "open") s.open++;
    s.claims += t.claims;
    if (t.claimAuthors.size > 1) s.races++;
    s.doneFacts += t.doneChildren;
    if (t.doneChildren > 1) s.dupes += t.doneChildren - 1;
    if (t.effectiveResolves > 1) s.dupes += t.effectiveResolves - 1;
    if (t.owner) s.byOwner.set(t.owner, (s.byOwner.get(t.owner) ?? 0) + 1);
  }
  return s;
}

// ─────────────────────────────────── main ────────────────────────────────────

async function main(): Promise<number> {
  const t0 = Date.now();
  const agents: Agent[] = [];
  let bus: RunningBus | null = null;

  const cleanup = async () => {
    for (const a of agents) { if (!a.dead) killAgent(a, "SIGKILL"); }
    try { bus?.close(); bus?.closeBus(); } catch { /* already down */ }
    if (OWN_DIR) { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ } }
  };
  process.on("SIGINT", () => { void cleanup().finally(() => process.exit(130)); });
  process.on("SIGTERM", () => { void cleanup().finally(() => process.exit(143)); });

  banner("ANTLEGION — THE KILLER DEMO", "a fact bus for multi-agent coordination · no locks · no leader · no commands");
  console.log(`  bus port     : ${FIXED_PORT ? `${FIXED_PORT} (fixed)` : "ephemeral (random)"}`);
  console.log(`  data dir     : ${DATA_DIR}${OWN_DIR ? "  (temp — deleted after run)" : "  (preserved)"}`);
  console.log(`  secret       : "${SECRET}" (stable → signatures survive restart)`);
  console.log(`  fsync        : ${FSYNC}   ·   tasks: ${TOTAL}   ·   claim timeout Δ: ${DELTA}s (trusted bus time)`);

  bus = await bootBus();
  const base = `http://localhost:${bus.port}`;
  console.log(`  bus          : ${base}  ${c("green", "● up")}`);
  console.log(`  dashboard    : ${c("bold", `${base}/dashboard?delta=${DELTA}`)}  ← open in a browser NOW`);

  const dispatcher = new ClientV2(httpTransport(base), "dispatcher", { claimTimeout: DELTA });
  const mirror = new Mirror(dispatcher);

  // ── ACT 1 ──────────────────────────────────────────────────────────────────
  banner("ACT 1 · THE RACE", `${TOTAL} tasks · 8 agent processes from 4 frameworks · exactly-once by total order`);

  console.log(c("dim", `  dispatcher publishing ${TOTAL} task.todo facts…`));
  const CHUNK = 50;
  for (let i = 0; i < TOTAL; i += CHUNK) {
    await Promise.all(
      Array.from({ length: Math.min(CHUNK, TOTAL - i) }, (_, k) =>
        dispatcher.publish("task.todo", { i: i + k })),
    );
  }
  console.log(c("dim", `  ${TOTAL} tasks on the bus. Spawning agents:`));

  const roster: Array<[string, string, "racer" | "victim"]> = [
    ["langgraph-1", "LangGraph", "racer"],
    ["langgraph-2", "LangGraph", "racer"],
    ["crewai-1", "CrewAI", "racer"],
    ["crewai-2", "CrewAI", "victim"], // marked for ACT 2
    ["claude-1", "Claude-Code-style", "racer"],
    ["claude-2", "Claude-Code-style", "racer"],
    ["script-1", "plain bash script", "racer"],
    ["script-2", "plain bash script", "racer"],
  ];
  for (const [name, fw, mode] of roster) {
    agents.push(spawnAgent(base, name, fw, mode));
    console.log(`    ${c("green", "⣿")} ${name.padEnd(14)} ${c("dim", fw.padEnd(19))} pid=${agents[agents.length - 1].child.pid}${mode === "victim" ? c("red", "   ← will be killed in ACT 2") : ""}`);
  }
  console.log("");

  const progress = (s: Stats, note = "") => {
    const pct = ((s.resolved / TOTAL) * 100).toFixed(1).padStart(5);
    const line = `  resolved ${String(s.resolved).padStart(3)}/${TOTAL} (${pct}%) · claimed ${s.claimed} · open ${s.open} · claim facts ${s.claims} · races ${s.races} · ${c("green", c("bold", `dupes ${s.dupes}`))}${note}`;
    process.stdout.write(`\r${line.padEnd(110)}`);
  };

  let stats = computeStats(new Map());
  while (stats.resolved < KILL_AT) {
    await mirror.pull();
    stats = computeStats(foldTasks(mirror.facts, Date.now() / 1000, DELTA));
    progress(stats);
    if (Date.now() - t0 > 45000) { console.log(""); console.error("timeout waiting for ACT 1"); await cleanup(); return 1; }
    await sleep(350);
  }
  process.stdout.write("\n");
  punch(`${stats.resolved} tasks already claimed & resolved by 4 frameworks racing on one log — ` +
    `${stats.races} contested, dupes = ${stats.dupes}. Not a lock. A theorem: lowest seq wins.`);

  // ── ACT 2 ──────────────────────────────────────────────────────────────────
  banner("ACT 2 · THE CRASH", "SIGKILL a real process holding live claims — watch the swarm heal itself");

  const victim = agents.find((a) => a.mode === "victim")!;
  // what is the victim holding right now? (brief wait so we never pull the
  // trigger in the gap between a drained batch and the next top-up)
  let strandedAtKill: TaskView[] = [];
  for (let i = 0; i < 12; i++) {
    await mirror.pull();
    stats = computeStats(foldTasks(mirror.facts, Date.now() / 1000, DELTA));
    strandedAtKill = [...stats.view.values()].filter((t) => t.state === "claimed" && t.owner === victim.name);
    if (strandedAtKill.length >= 3 || victim.dead || stats.resolved >= TOTAL) break;
    await sleep(250);
  }
  const lastVictimSeqAtKill = mirror.facts.filter((f) => f.author === victim.name).reduce((m, f) => Math.max(m, f.seq), 0);
  console.log(`  ${c("red", c("bold", `kill -9 ${victim.name}`))} (pid ${victim.child.pid}) — it holds ${c("bold", String(strandedAtKill.length))} unresolved claims`);
  killAgent(victim, "SIGKILL"); // whole process group: tsx supervisor + worker (see killAgent)
  for (let i = 0; i < 60 && !victim.dead; i++) await sleep(50);
  console.log(c("dim", `  process reaped (signal ${victim.exitSignal ?? "?"}). No orchestrator was notified — none exists.`));
  console.log(c("dim", `  stale claims expire on the trusted bus clock (recv + Δ=${DELTA}s). Survivors keep folding…\n`));

  let healed = false;
  while (Date.now() - t0 < 75000) {
    await mirror.pull();
    stats = computeStats(foldTasks(mirror.facts, Date.now() / 1000, DELTA));
    const strandedNow = [...stats.view.values()].filter((t) => t.state === "claimed" && t.owner === victim.name).length;
    progress(stats, ` · stranded by ${victim.name}: ${strandedNow}`);
    if (stats.resolved >= TOTAL) { healed = true; break; }
    await sleep(350);
  }
  process.stdout.write("\n");

  if (!healed) { console.error("timeout: swarm did not finish"); await cleanup(); return 1; }

  const strandedIds = new Set(strandedAtKill.map((t) => t.id));
  const redispatched = [...stats.view.values()].filter(
    (t) => strandedIds.has(t.id) && t.state === "resolved" && t.owner !== victim.name,
  );
  // death certificate: the bus must have seen NOTHING from the victim after the kill
  const victimFactsAfterKill = mirror.facts.filter((f) => f.author === victim.name && f.seq > lastVictimSeqAtKill).length;
  const elapsed2 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  ${c("bold", "final tally")}: ${stats.resolved}/${TOTAL} resolved in ${elapsed2}s · claim races ${stats.races} · ${c("green", c("bold", `duplicates ${stats.dupes}`))}`);
  console.log(`  ${c("bold", "death cert")}  : ${victim.name} published ${victimFactsAfterKill} facts after the kill ${victimFactsAfterKill === 0 ? c("green", "(truly dead ✓)") : c("red", "(ZOMBIE! ✗)")}`);
  console.log(`  ${c("bold", "re-dispatch")} : ${redispatched.length}/${strandedAtKill.length} tasks held by dead ${victim.name} at kill time were re-won & finished by survivors:`);
  const rescueCount = new Map<string, number>();
  for (const t of redispatched) rescueCount.set(t.owner!, (rescueCount.get(t.owner!) ?? 0) + 1);
  console.log(`                 ${[...rescueCount.entries()].map(([n, k]) => `${n} +${k}`).join("  ")}`);
  const dist = [...stats.byOwner.entries()].sort((a, b) => b[1] - a[1])
    .map(([n, k]) => `${n}:${k}`).join("  ");
  console.log(`  ${c("bold", "work split")}   : ${dist}`);
  punch(`${TOTAL} tasks, 4 frameworks, 1 dead agent, 0 duplicates — nobody reassigned anything. ` +
    `${redispatched.length} orphaned claims expired on bus time and were re-won. The order decided.`);

  // stop the survivors before the replay act
  for (const a of agents) { if (!a.dead) killAgent(a, "SIGTERM"); }
  await sleep(400);
  for (const a of agents) { if (!a.dead) killAgent(a, "SIGKILL"); }

  // ── ACT 3 ──────────────────────────────────────────────────────────────────
  banner("ACT 3 · THE REPLAY", "kill the bus, restart from the journal, prove the state is byte-identical");

  await mirror.pull();
  const before = JSON.stringify(mirror.facts);
  const headBefore = (await (await fetch(`${base}/facts/head`)).json() as { head_seq: number }).head_seq;
  const digestBefore = sha256(before);
  const stateBefore = computeStats(foldTasks(mirror.facts, Date.now() / 1000, DELTA)).view;
  const stateMapBefore = JSON.stringify(
    [...stateBefore.values()].map((t) => [t.i, t.state, t.owner]).sort((a, b) => (a[0] as number) - (b[0] as number)),
  );
  console.log(`  snapshot      : head_seq=${headBefore} · facts=${mirror.facts.length} · stream sha256=${digestBefore.slice(0, 16)}…`);

  const journal = join(DATA_DIR, "facts-v2.jsonl");
  console.log(`  ${c("red", c("bold", "killing the bus"))} — the only state that survives is ${c("bold", journal)}`);
  bus.close();
  bus.closeBus();
  bus = null;
  await sleep(300);
  const jSize = statSync(journal).size;
  console.log(c("dim", `  bus is down. journal: ${jSize} bytes, append-only JSONL. No broker state, no side DB, nothing to sync.`));
  await sleep(700); // let the dashboard (if attached) notice the outage

  console.log(c("dim", `  restarting from the same journal + secret…`));
  bus = await bootBus();
  const base2 = `http://localhost:${bus.port}`;
  console.log(`  bus          : ${base2}  ${c("green", "● up (replayed)")}`);

  const reader = new ClientV2(httpTransport(base2), "auditor", { claimTimeout: DELTA });
  const mirror2 = new Mirror(reader);
  await mirror2.pull();
  const headAfter = (await (await fetch(`${base2}/facts/head`)).json() as { head_seq: number }).head_seq;
  const digestAfter = sha256(JSON.stringify(mirror2.facts));
  const stateAfter = computeStats(foldTasks(mirror2.facts, Date.now() / 1000, DELTA)).view;
  const stateMapAfter = JSON.stringify(
    [...stateAfter.values()].map((t) => [t.i, t.state, t.owner]).sort((a, b) => (a[0] as number) - (b[0] as number)),
  );

  const headOK = headAfter === headBefore;
  const streamOK = digestAfter === digestBefore;
  const stateOK = stateMapAfter === stateMapBefore;
  console.log(`  replay check  : head_seq ${headAfter} ${headOK ? c("green", "== pre-kill ✓") : c("red", `!= ${headBefore} ✗`)}`);
  console.log(`                  stream sha256 ${digestAfter.slice(0, 16)}… ${streamOK ? c("green", "identical ✓") : c("red", "DIVERGED ✗")}`);
  console.log(`                  per-task owner/state fold (${stateAfter.size} tasks) ${stateOK ? c("green", "identical ✓") : c("red", "DIVERGED ✗")}`);

  // ── verdict ────────────────────────────────────────────────────────────────
  const finalStats = computeStats(foldTasks(mirror2.facts, Date.now() / 1000, DELTA));
  const allResolved = finalStats.resolved === TOTAL;
  const dupesOK = finalStats.dupes === 0;
  const redispatchOK = strandedAtKill.length > 0 && redispatched.length === strandedAtKill.length && victimFactsAfterKill === 0;
  const PASS = allResolved && dupesOK && redispatchOK && headOK && streamOK && stateOK && victim.dead;
  const totalS = ((Date.now() - t0) / 1000).toFixed(1);

  banner("VERDICT", `total runtime ${totalS}s`);
  console.log(`  ACT 1  exactly-once race      : ${dupesOK ? c("green", "✓") : c("red", "✗")}  ${TOTAL} tasks · ${stats.races} races · dupes ${finalStats.dupes}`);
  console.log(`  ACT 2  crash → re-dispatch    : ${redispatchOK && allResolved ? c("green", "✓") : c("red", "✗")}  ${victim.name} SIGKILLed · ${redispatched.length} claims re-won · ${finalStats.resolved}/${TOTAL} resolved`);
  console.log(`  ACT 3  replay byte-identical  : ${headOK && streamOK && stateOK ? c("green", "✓") : c("red", "✗")}  head_seq ${headAfter} · stream hash match · task fold match`);
  console.log("");
  if (PASS) {
    punch("The queue gives you at-least-once and a prayer. The mailbox gives you a server to trust. " +
      "This gives you a total order — exactly-once, crash recovery, and audit are just ways of reading it.");
  }
  console.log(c("bold", `  ${PASS ? c("green", "✅ KILLER DEMO PASSED") : c("red", "❌ DEMO FAILED")}`));
  console.log("");
  console.log(c("bold", "  next steps"));
  console.log(`    keep a bus around      : ${c("bold", "npx @antlegion/bus")}`);
  console.log(`    give your agents tools : ${c("bold", "claude mcp add antlegion -- npx -y -p @antlegion/bus antlegion-mcp")}`);
  console.log(`    resident DCU fleet     : ${c("bold", "npx @antlegion/ant chain")}`);
  console.log(c("dim", "    docs → https://github.com/YangKGcsdms/AntLegion (Connect via MCP)"));
  console.log("");

  if (KEEP_BUS && PASS) {
    console.log(c("dim", `  leaving a replayed bus on :${bus.port} for the dashboard (detached)…`));
    const child = spawn(process.execPath, [join(HERE, "index.js")], {
      detached: true, stdio: "ignore",
      env: {
        ...process.env,
        PORT: String(bus.port),
        ANTLEGION_DATA_DIR: DATA_DIR,
        ANTLEGION_BUS_SECRET: SECRET,
        ANTLEGION_FSYNC: FSYNC,
      },
    });
    child.unref();
    console.log(`  dashboard → ${c("bold", `http://localhost:${bus.port}/dashboard?delta=${DELTA}`)}`);
    console.log(c("dim", `  (kill it later with: lsof -ti :${bus.port} | xargs kill)`));
  }
  if (!OWN_DIR) console.log(c("dim", `  journal preserved at ${journal} — restart any time:\n    PORT=${bus.port} ANTLEGION_BUS_SECRET=${SECRET} ANTLEGION_DATA_DIR=${DATA_DIR} npx tsx src/index.ts`));

  await cleanup();
  return PASS ? 0 : 1;
}

/** Entry used by index.ts (`antlegion demo`). */
export async function runDemo(): Promise<never> {
  let code = 1;
  try { code = await main(); } catch (e) { console.error(e); }
  process.exit(code);
}
