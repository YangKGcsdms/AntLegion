/**
 * m1m3-lib.ts — shared plumbing for the M1/M3 paired experiment
 * (评估宪章 .cowork/11-隔离协作评估指标.md §5).
 *
 * Two arms, same task, same simulated workers, same human-time budget:
 *   A 臂: N isolated worker processes (own data dirs, no shared bus); every
 *        cross-node handoff is performed by a deterministic "human relay"
 *        script — each transfer / window-glance / gate decision is one
 *        counted human touchpoint.
 *   B 臂: the same N worker processes as DCUs on one AntLegion bus;
 *        ANT_AUTO_GATE stays off — the only human touches left are the H1
 *        gate decisions (published as gate.approved facts by the harness).
 *
 * The metrics (M1 relay/adjudication split, M2 unattended span, M3 curve
 * data points) are collected from the relay script's own log (A) and from
 * folding the fact log (B) — zero manual bookkeeping.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Stage } from "../src/folds/devchain.js";

export const ANT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TSX_CLI = path.join(ANT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
export const BUS_ENTRY = path.join(ANT_ROOT, "node_modules", "@antlegion", "bus", "dist", "index.js");

/**
 * The deterministic human model — identical budget in both arms.
 * Every value is declared in the report; changing one changes the numbers,
 * not the shape of the curve.
 */
export const HUMAN = {
  /** Looking at one node's window/outbox once. */
  GLANCE_MS: 250,
  /** Carrying one message between two windows (copy-paste + context switch). */
  CARRY_MS: 750,
  /** One real adjudication (H1 方案评审) — same pause in both arms. */
  GATE_MS: 1000,
  /** Idle wait after a full sweep found nothing (A 臂 only). */
  POLL_MS: 2000,
} as const;

export type TouchKind = "feed" | "carry" | "glance" | "gate";

export interface Touch {
  kind: TouchKind;
  /** ms since round start */
  at: number;
  detail: string;
}

export interface RoundResult {
  arm: "A" | "B";
  n: number;
  reqs: number;
  elapsed_s: number;
  touches: Record<TouchKind, number>;
  /** M1 中继类 = carry + glance (both replaceable by "读一次 fold"). */
  m1_relay: number;
  /** M1 裁决类 = gate decisions (must NOT shrink between arms). */
  m1_adjudication: number;
  /** M2: longest wall-clock span with zero substantive human touches (s). */
  m2_max_gap_s: number;
  /** M2: most consecutive stages advanced without a substantive human touch. */
  m2_stage_span: number;
  /** Machine evidence-shape checks (adjudications by code, both arms). */
  machine_checks: number;
  notes: Record<string, unknown>;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Stage layout per node for a given N. N=8 = two replicas of each stage. */
export function nodeLayout(n: number): Stage[][] {
  switch (n) {
    case 2: return [["plan", "dev"], ["unittest", "e2e"]];
    case 4: return [["plan"], ["dev"], ["unittest"], ["e2e"]];
    case 8: return [["plan"], ["dev"], ["unittest"], ["e2e"], ["plan"], ["dev"], ["unittest"], ["e2e"]];
    default: throw new Error(`unsupported N=${n} (use 2, 4, or 8)`);
  }
}

/** Spawn a .ts script through the package-local tsx, logs to a file. */
export async function spawnTsx(
  script: string, env: Record<string, string>, logFile: string,
): Promise<ChildProcess> {
  const out = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [TSX_CLI, script], {
    cwd: ANT_ROOT,
    env: { ...process.env, ANT_WORKER: "simulated", ...env },
    stdio: ["ignore", out.fd, out.fd],
  });
  child.on("spawn", () => void out.close());
  return child;
}

export function killAll(children: ChildProcess[]): void {
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

export async function mkRunDir(tag: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `m1m3-${tag}-`));
}

/** Substantive touches = feed + carry + gate (glances are attention, not action). */
export function substantiveGaps(touches: Touch[], endAt: number): number {
  const times = touches.filter((t) => t.kind !== "glance").map((t) => t.at).sort((a, b) => a - b);
  let max = 0;
  let prev = 0;
  for (const t of [...times, endAt]) {
    if (t - prev > max) max = t - prev;
    prev = t;
  }
  return max / 1000;
}

export function countTouches(touches: Touch[]): Record<TouchKind, number> {
  const c: Record<TouchKind, number> = { feed: 0, carry: 0, glance: 0, gate: 0 };
  for (const t of touches) c[t.kind]++;
  return c;
}

// ── A-arm file protocol (inbox/outbox JSON messages moved by the human) ──

export interface NodeTask {
  taskId: string;
  reqSlug: string;
  reqName: string;
  /** Stage to execute. */
  stage: Stage;
  /** Upstream artifact payload (null for plan — its input is the req itself). */
  input: Record<string, unknown> | null;
  /** Fact type of the upstream artifact (for the receiver-side shape check). */
  inputType: string | null;
}

export interface NodeOutput {
  taskId: string;
  nodeId: string;
  reqSlug: string;
  reqName: string;
  /** Last stage executed for this task. */
  stage: Stage;
  artifactType: string;
  payload: Record<string, unknown>;
  /** Stages executed consecutively for this task with no human in between. */
  internalStages: Stage[];
  /** plan.ready must pass the H1 gate before dev may start. */
  awaitingGate: boolean;
  /** Evidence-shape checks this node performed (machine, not human). */
  checksDone: number;
  rejected?: { stage: Stage; missing: string[] };
}

/** Atomic JSON drop: write hidden temp, then rename into place. */
export async function dropJson(dir: string, name: string, data: unknown): Promise<void> {
  const tmp = path.join(dir, `.tmp-${name}`);
  await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
  await fs.rename(tmp, path.join(dir, name));
}

/** Read + remove every visible JSON message in a directory (FIFO by name). */
export async function takeJson<T>(dir: string): Promise<T[]> {
  let names: string[];
  try { names = (await fs.readdir(dir)).filter((f) => !f.startsWith(".")).sort(); }
  catch { return []; }
  const out: T[] = [];
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      out.push(JSON.parse(await fs.readFile(p, "utf-8")) as T);
      await fs.unlink(p);
    } catch { /* half-written (should not happen: writes are atomic) — retry next poll */ }
  }
  return out;
}
