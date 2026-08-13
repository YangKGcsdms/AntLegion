/**
 * m1m3-arm-a.ts — A arm: N isolated nodes + a deterministic "human relay".
 *
 * The harness plays the human of the baseline world (评估宪章 §一): N agent
 * windows that cannot see each other, a person carrying every artifact
 * between them. The human is modeled as a serial, deterministic loop:
 *
 *   sweep the windows in order (each look = 1 glance touch, GLANCE_MS)
 *   → for every finished artifact found:
 *       plan.ready  → H1 decision (1 gate touch, GATE_MS)
 *                     then carry artifact+approval to the dev node (1 carry)
 *       dev.done    → carry to the unittest node (1 carry)
 *       unit report → carry to the e2e node (1 carry)
 *       e2e.report  → machine-check + file into the done record (1 carry)
 *   → if the whole sweep found nothing: wait POLL_MS (human steps away)
 *
 * Every touch is logged with a timestamp; M1/M2 fall straight out of that
 * log. Task submission (feed) is counted separately in both arms — it is the
 * task itself, not relay labor.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { DEVCHAIN, STAGES, type Stage } from "../src/folds/devchain.js";
import {
  HUMAN, countTouches, dropJson, killAll, mkRunDir, nodeLayout, sleep, spawnTsx,
  substantiveGaps, takeJson, type NodeOutput, type NodeTask, type RoundResult, type Touch,
} from "./m1m3-lib.js";

const NODE_A = path.join(path.dirname(new URL(import.meta.url).pathname), "m1m3-node-a.ts");
const ROUND_TIMEOUT_MS = 15 * 60 * 1000;

export async function runArmA(n: number, reqs: number): Promise<RoundResult> {
  const layout = nodeLayout(n);
  const runDir = await mkRunDir(`a-n${n}`);
  const log = (m: string) => console.error(`[arm-a n=${n}] ${new Date().toISOString()} ${m}`);
  log(`run dir ${runDir}`);

  // Which nodes host which stage (replicas at N=8 → round-robin dispatch).
  const nodesByStage = new Map<Stage, number[]>();
  layout.forEach((stages, i) => {
    for (const s of stages) nodesByStage.set(s, [...(nodesByStage.get(s) ?? []), i]);
  });
  const rr = new Map<Stage, number>();
  const pickNode = (s: Stage): number => {
    const nodes = nodesByStage.get(s)!;
    const i = (rr.get(s) ?? 0) % nodes.length;
    rr.set(s, i + 1);
    return nodes[i]!;
  };

  const children: ChildProcess[] = [];
  const inboxOf = (i: number) => path.join(runDir, `node-${i}`, "inbox");
  const outboxOf = (i: number) => path.join(runDir, `node-${i}`, "outbox");

  const touches: Touch[] = [];
  const t0 = Date.now();
  const touch = async (kind: Touch["kind"], detail: string, costMs: number): Promise<void> => {
    touches.push({ kind, at: Date.now() - t0, detail });
    await sleep(costMs);
  };

  try {
    // Boot the isolated nodes (process ≈ container — declared approximation).
    for (let i = 0; i < layout.length; i++) {
      const dataDir = path.join(runDir, `node-${i}`);
      await fs.mkdir(inboxOf(i), { recursive: true });
      await fs.mkdir(outboxOf(i), { recursive: true });
      children.push(await spawnTsx(NODE_A, {
        M1M3_NODE_ID: `node-${i}[${layout[i]!.join("+")}]`,
        M1M3_STAGES: layout[i]!.join(","),
        M1M3_DATA_DIR: dataDir,
      }, path.join(runDir, `node-${i}.log`)));
    }
    await sleep(1500); // let the node loops come up

    // Feed: hand each requirement to a plan-capable window.
    let taskSeq = 0;
    for (let i = 1; i <= reqs; i++) {
      const slug = `m1m3-a-${String(i).padStart(2, "0")}`;
      const target = pickNode("plan");
      await touch("feed", `req ${slug} → node-${target}`, HUMAN.CARRY_MS);
      const task: NodeTask = {
        taskId: `t${++taskSeq}`, reqSlug: slug, reqName: `M1M3需求${i}`,
        stage: "plan", input: null, inputType: null,
      };
      await dropJson(inboxOf(target), `task-${String(taskSeq).padStart(4, "0")}.json`, task);
    }
    log(`fed ${reqs} requirements`);

    // The human relay loop.
    const doneRecord = new Map<string, NodeOutput>();
    let machineChecks = 0;
    let maxStageSpan = 0;
    const stageOfArtifact = (t: string): Stage => {
      for (const s of STAGES) if (DEVCHAIN[s].produces === t) return s;
      throw new Error(`unknown artifact type ${t}`);
    };

    while (doneRecord.size < reqs) {
      if (Date.now() - t0 > ROUND_TIMEOUT_MS) throw new Error("A-arm round timed out");
      let found = 0;
      for (let i = 0; i < layout.length; i++) {
        await touch("glance", `look at node-${i}`, HUMAN.GLANCE_MS);
        for (const out of await takeJson<NodeOutput>(outboxOf(i))) {
          found++;
          machineChecks += out.checksDone;
          if (out.internalStages.length > maxStageSpan) maxStageSpan = out.internalStages.length;
          if (out.rejected) throw new Error(`node-${i} rejected ${out.reqSlug}: missing ${out.rejected.missing.join(",")}`);

          const produced = stageOfArtifact(out.artifactType);
          if (out.awaitingGate) {
            // H1 方案评审 — the one touch that must NOT disappear in the B arm.
            await touch("gate", `H1 approve plan of ${out.reqSlug}`, HUMAN.GATE_MS);
          }
          const nxt = STAGES[STAGES.indexOf(produced) + 1];
          if (!nxt) {
            // Final artifact: machine-check, then file it into the done record.
            machineChecks++;
            const missing = DEVCHAIN[produced].evidence.check(out.payload);
            if (missing.length > 0) throw new Error(`final artifact of ${out.reqSlug} missing ${missing.join(",")}`);
            await touch("carry", `${out.artifactType} of ${out.reqSlug} → done record`, HUMAN.CARRY_MS);
            doneRecord.set(out.reqSlug, out);
            log(`chain done ${doneRecord.size}/${reqs} (${out.reqSlug})`);
          } else {
            const target = pickNode(nxt);
            await touch("carry", `${out.artifactType} of ${out.reqSlug} → node-${target} (${nxt})`, HUMAN.CARRY_MS);
            const task: NodeTask = {
              taskId: `t${++taskSeq}`, reqSlug: out.reqSlug, reqName: out.reqName,
              stage: nxt, input: out.payload, inputType: out.artifactType,
            };
            await dropJson(inboxOf(target), `task-${String(taskSeq).padStart(4, "0")}.json`, task);
          }
        }
      }
      if (found === 0) await sleep(HUMAN.POLL_MS); // nothing anywhere — human steps away
    }

    const elapsed = Date.now() - t0;
    const counts = countTouches(touches);
    return {
      arm: "A", n, reqs,
      elapsed_s: +(elapsed / 1000).toFixed(1),
      touches: counts,
      m1_relay: counts.carry + counts.glance,
      m1_adjudication: counts.gate,
      m2_max_gap_s: +substantiveGaps(touches, elapsed).toFixed(1),
      m2_stage_span: maxStageSpan,
      machine_checks: machineChecks,
      notes: {
        human_model: HUMAN,
        isolation: "one OS process + private data dir per node (≈ container); handoff via files moved by this harness only",
        carry_split: { feed: counts.feed, carry: counts.carry },
      },
    };
  } finally {
    killAll(children);
  }
}
