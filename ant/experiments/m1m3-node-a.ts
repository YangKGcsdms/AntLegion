/**
 * m1m3-node-a.ts — one ISOLATED worker node for the A arm (human-relay baseline).
 *
 * Approximation declared in the report: an OS process with its own data dir
 * stands in for an isolated container/machine. The node can see ONLY its own
 * inbox/outbox directories; it has no bus, no shared state, no knowledge of
 * the other nodes. The only way information reaches it is the human relay
 * dropping a task file into its inbox.
 *
 * The node runs the SAME simulated stage workers as the B arm (SIM_WORKERS /
 * WORK_MS from src/dcus/devchain-dcus.ts) and performs the SAME evidence-shape
 * checks (DEVCHAIN[..].evidence.check) on every input it receives — the
 * machine part of adjudication, relocated to the receiver because there is no
 * bus-side adjudicator here. Stages colocated on one node hand off internally
 * (one agent doing two phases in one window); the H1 gate always forces the
 * plan artifact out to the human.
 *
 * Env: M1M3_NODE_ID · M1M3_STAGES (csv) · M1M3_DATA_DIR
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEVCHAIN, STAGES, type Stage } from "../src/folds/devchain.js";
import { SIM_WORKERS, WORK_MS } from "../src/dcus/devchain-dcus.js";
import type { DCUContext } from "../src/runtime.js";
import type { ReqChainView } from "../src/folds/devchain.js";
import { sleep, dropJson, takeJson, type NodeTask, type NodeOutput } from "./m1m3-lib.js";

const NODE_ID = process.env.M1M3_NODE_ID ?? "node-?";
const MY_STAGES = new Set((process.env.M1M3_STAGES ?? "").split(",").filter(Boolean) as Stage[]);
const DATA_DIR = process.env.M1M3_DATA_DIR!;
const INBOX = path.join(DATA_DIR, "inbox");
const OUTBOX = path.join(DATA_DIR, "outbox");

const log = (m: string) => console.error(`[${NODE_ID}] ${new Date().toISOString()} ${m}`);

/** Minimal stand-ins: SIM_WORKERS only touch req.slug / req.name / ctx.log. */
const fakeCtx = { client: null, busUrl: "", mirror: [], log } as unknown as DCUContext;
const reqView = (slug: string, name: string) => ({ slug, name } as unknown as ReqChainView);

/** The stage whose artifact type is `t` (for receiver-side shape checks). */
function producerOf(t: string): Stage | null {
  for (const s of STAGES) if (DEVCHAIN[s].produces === t) return s;
  return null;
}

const nextStage = (s: Stage): Stage | null => STAGES[STAGES.indexOf(s) + 1] ?? null;

interface QueueItem { task: NodeTask; soFar: Stage[]; checksSoFar: number }

// One serial queue per stage role (mirrors the B arm: one DCU identity per
// stage works serially; distinct stages on the same node work concurrently).
const queues = new Map<Stage, QueueItem[]>();
const running = new Set<Stage>();
let outSeq = 0;

async function emit(o: NodeOutput): Promise<void> {
  await dropJson(OUTBOX, `out-${String(++outSeq).padStart(4, "0")}-${o.reqSlug}-${o.stage}.json`, o);
}

async function runQueue(stage: Stage): Promise<void> {
  if (running.has(stage)) return;
  running.add(stage);
  try {
    for (;;) {
      const item = queues.get(stage)?.shift();
      if (!item) break;
      await handle(stage, item);
    }
  } finally {
    running.delete(stage);
  }
}

async function handle(stage: Stage, { task, soFar, checksSoFar }: QueueItem): Promise<void> {
  let checks = checksSoFar;

  // Receiver-side evidence-shape check on the input (machine, not human).
  if (task.input && task.inputType) {
    const from = producerOf(task.inputType);
    if (from) {
      checks++;
      const missing = DEVCHAIN[from].evidence.check(task.input);
      if (missing.length > 0) {
        log(`REJECTED input ${task.inputType} of ${task.reqSlug} — missing ${missing.join(",")}`);
        await emit({
          taskId: task.taskId, nodeId: NODE_ID, reqSlug: task.reqSlug, reqName: task.reqName,
          stage, artifactType: task.inputType, payload: task.input, internalStages: [],
          awaitingGate: false, checksDone: checks, rejected: { stage, missing },
        });
        return;
      }
    }
  }

  // Same work, same budget as the B arm's stage DCU.
  log(`working ${stage} of ${task.reqSlug} (${WORK_MS[stage]}ms, simulated)`);
  await sleep(WORK_MS[stage]);
  const payload = await SIM_WORKERS[stage](reqView(task.reqSlug, task.reqName), fakeCtx, DATA_DIR);
  const done = [...soFar, stage];

  // Internal handoff: next stage lives on this node AND no human gate blocks
  // it. The continuation's receiver-side check covers this artifact, so every
  // artifact is shape-checked exactly once — matching the B arm's one
  // adjudication per artifact.
  const nxt = nextStage(stage);
  const gated = nxt !== null && DEVCHAIN[nxt].gate !== null; // H1 sits before dev
  if (nxt && MY_STAGES.has(nxt) && !gated) {
    log(`internal handoff ${stage} → ${nxt} for ${task.reqSlug}`);
    queues.get(nxt)!.push({
      task: { ...task, stage: nxt, input: payload, inputType: DEVCHAIN[stage].produces },
      soFar: done,
      checksSoFar: checks,
    });
    void runQueue(nxt);
    return;
  }

  await emit({
    taskId: task.taskId, nodeId: NODE_ID, reqSlug: task.reqSlug, reqName: task.reqName,
    stage, artifactType: DEVCHAIN[stage].produces, payload,
    internalStages: done, awaitingGate: gated, checksDone: checks,
  });
  log(`emitted ${DEVCHAIN[stage].produces} of ${task.reqSlug}${gated ? " (awaiting H1)" : ""}`);
}

async function main(): Promise<void> {
  await fs.mkdir(INBOX, { recursive: true });
  await fs.mkdir(OUTBOX, { recursive: true });
  for (const s of MY_STAGES) queues.set(s, []);
  log(`isolated node up — stages [${[...MY_STAGES].join(",")}], data ${DATA_DIR}`);

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { stopping = true; });
  }

  while (!stopping) {
    for (const task of await takeJson<NodeTask>(INBOX)) {
      if (!MY_STAGES.has(task.stage)) {
        log(`misrouted task ${task.taskId} (stage ${task.stage}) — ignoring`);
        continue;
      }
      queues.get(task.stage)!.push({ task, soFar: [], checksSoFar: 0 });
      void runQueue(task.stage);
    }
    await sleep(200);
  }
  log("stopped");
}

main().catch((e) => { console.error(e); process.exit(1); });
