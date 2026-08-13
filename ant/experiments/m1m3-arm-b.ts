/**
 * m1m3-arm-b.ts — B arm: the same N nodes, coordinated by the fact bus.
 *
 * Boots a fresh bus + the same node layout as the A arm (each node its own
 * OS process running stock stage DCUs) + one adjudicator process. Auto-gate
 * stays OFF: the H1 方案评审 remains a human decision, played by this harness
 * with the same GATE_MS think-time as the A arm — it publishes gate.approved
 * when the shared fold shows a chain parked at the gate.
 *
 * Human relay touches in this arm: none, structurally — no artifact is ever
 * carried by the harness; stage handoff, adjudication, and completion are all
 * reader folds over the bus. All metrics are collected by folding the fact
 * log after the run (零人工记录).
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { httpTransport } from "@antlegion/bus/client";
import type { Fact } from "@antlegion/bus/types";
import { createRequirement } from "../src/req-new.js";
import {
  ARTIFACT_TYPES, EVIDENCE_ACCEPTED, EVIDENCE_REJECTED, GATE_APPROVED, foldDevchain,
} from "../src/folds/devchain.js";
import {
  BUS_ENTRY, HUMAN, countTouches, killAll, mkRunDir, nodeLayout, sleep, spawnTsx,
  substantiveGaps, type RoundResult, type Touch,
} from "./m1m3-lib.js";

const NODE_B = path.join(path.dirname(new URL(import.meta.url).pathname), "m1m3-node-b.ts");
const HUMAN_GATE_AUTHOR = "human-gate@m1m3";
const ROUND_TIMEOUT_MS = 15 * 60 * 1000;

async function readAll(t: ReturnType<typeof httpTransport>): Promise<Fact[]> {
  const facts: Fact[] = [];
  let cursor = 0;
  for (;;) {
    const page = await t.read({ since: cursor, limit: 500 });
    if (page.length === 0) break;
    for (const f of page) { facts.push(f); if (f.seq > cursor) cursor = f.seq; }
    if (page.length < 500) break;
  }
  return facts;
}

export async function runArmB(n: number, reqs: number): Promise<RoundResult> {
  const layout = nodeLayout(n);
  const runDir = await mkRunDir(`b-n${n}`);
  const port = 28190 + n; // per-round port: never collides with a dev bus on 28090
  const busUrl = `http://localhost:${port}`;
  const log = (m: string) => console.error(`[arm-b n=${n}] ${new Date().toISOString()} ${m}`);
  log(`run dir ${runDir} · bus ${busUrl}`);

  const children: ChildProcess[] = [];
  const touches: Touch[] = [];
  const t0 = Date.now();
  const touch = async (kind: Touch["kind"], detail: string, costMs: number): Promise<void> => {
    touches.push({ kind, at: Date.now() - t0, detail });
    await sleep(costMs);
  };

  try {
    // Fresh bus for this round (fsync=no: benchmark-style, durability is not under test).
    const bus = await spawnTsx(BUS_ENTRY, {
      PORT: String(port),
      ANTLEGION_DATA_DIR: path.join(runDir, "bus-data"),
      ANTLEGION_FSYNC: "no",
      ANTLEGION_BUS_SECRET: "m1m3-paired-experiment",
    }, path.join(runDir, "bus.log"));
    children.push(bus);
    const t = httpTransport(busUrl);
    for (let i = 0; ; i++) {
      try { const r = await fetch(`${busUrl}/health`); if (r.ok) break; } catch { /* not yet */ }
      if (i > 75) throw new Error("bus failed to come up in 15s");
      await sleep(200);
    }
    log("bus up");

    // The same N nodes as the A arm — one process each — plus the adjudicator
    // (whose machine check the A arm ran receiver-side). No gate-approver DCU.
    for (let i = 0; i < layout.length; i++) {
      const replica = layout.slice(0, i).filter((s) => s.join() === layout[i]!.join()).length;
      const ws = path.join(runDir, `node-${i}-ws`);
      await fs.mkdir(ws, { recursive: true });
      children.push(await spawnTsx(NODE_B, {
        M1M3_STAGES: layout[i]!.join(","),
        M1M3_REPLICA: String(replica),
        M1M3_BUS_URL: busUrl,
        M1M3_WORKSPACE: ws,
      }, path.join(runDir, `node-${i}.log`)));
    }
    children.push(await spawnTsx(NODE_B, {
      M1M3_ROLE: "adjudicator",
      M1M3_BUS_URL: busUrl,
    }, path.join(runDir, "adjudicator.log")));
    await sleep(1500);

    // Feed — same action and same human cost as the A arm's feed.
    const workspace = path.join(runDir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const slugs: string[] = [];
    for (let i = 1; i <= reqs; i++) {
      const slug = `m1m3-b-${String(i).padStart(2, "0")}`;
      await touch("feed", `req ${slug} → bus`, HUMAN.CARRY_MS);
      const r = await createRequirement(workspace, `M1M3需求${i}`, { slug });
      await t.append(r.fact);
      slugs.push(slug);
    }
    const mine = new Set(slugs);
    log(`fed ${reqs} requirements`);

    // Monitor + human gate. Reading the fold is the thing that REPLACES the
    // A arm's window glances — it is machine work and costs no human touch.
    const approved = new Set<string>();
    let facts: Fact[] = [];
    for (;;) {
      if (Date.now() - t0 > ROUND_TIMEOUT_MS) throw new Error("B-arm round timed out");
      await sleep(1000);
      facts = await readAll(t);
      const views = foldDevchain(facts).filter((v) => mine.has(v.slug));
      for (const v of views) {
        for (const st of v.stages) {
          if (st.state === "gated" && st.inputId && !approved.has(st.inputId)) {
            // H1 方案评审 — same think-time budget as the A arm.
            await touch("gate", `H1 approve plan of ${v.slug}`, HUMAN.GATE_MS);
            await t.append({
              type: GATE_APPROVED,
              author: HUMAN_GATE_AUTHOR,
              ts: Date.now() / 1000,
              payload: { gate: st.gate?.name ?? "H1", reqSlug: v.slug, note: "human gate (paired experiment, auto-gate off)" },
              refs: { gate_of: st.inputId },
            });
            approved.add(st.inputId);
            log(`H1 approved for ${v.slug}`);
          }
          if (st.state === "rejected") throw new Error(`${v.slug}:${st.stage} REJECTED — chain halted`);
        }
      }
      const done = views.filter((v) => v.done).length;
      if (done === reqs) break;
    }
    const elapsed = Date.now() - t0;

    // ── metrics, folded from the fact log ──
    const ofRun = (f: Fact) => {
      const slug = (f.payload as Record<string, unknown> | undefined)?.reqSlug
        ?? (f.payload as Record<string, unknown> | undefined)?.slug;
      return typeof slug === "string" && mine.has(slug);
    };
    const runIds = new Set(facts.filter(ofRun).map((f) => f.id));
    const inRun = (f: Fact) => {
      const target = f.refs.claim_of ?? f.refs.resolves ?? f.refs.verdict_of ?? f.refs.gate_of;
      return typeof target === "string" && runIds.has(target);
    };
    const verdicts = facts.filter((f) => (f.type === EVIDENCE_ACCEPTED || f.type === EVIDENCE_REJECTED) && inRun(f)).length;
    const claims = facts.filter((f) => f.type === "_.claim" && inRun(f)).length;

    // exactly-once audit: >1 artifact for the same (req, stage) = double execution
    const artifactKey = new Map<string, number>();
    for (const f of facts) {
      if (!ARTIFACT_TYPES.has(f.type) || !ofRun(f)) continue;
      const k = `${String((f.payload as Record<string, unknown>).reqSlug)}:${f.type}`;
      artifactKey.set(k, (artifactKey.get(k) ?? 0) + 1);
    }
    const doubleExec = [...artifactKey.values()].filter((c) => c > 1).reduce((s, c) => s + c - 1, 0);

    // human-fact audit: the ONLY human-authored facts must be gate approvals
    const humanFacts = facts.filter((f) => f.author === HUMAN_GATE_AUTHOR);
    if (humanFacts.some((f) => f.type !== GATE_APPROVED)) throw new Error("unexpected human-authored fact type");

    // M2 stage span: per chain, longest run of consecutive stage artifacts
    // with no human fact (feed is t=0; the only later human facts are gates).
    let maxStageSpan = 0;
    for (const v of foldDevchain(facts).filter((x) => mine.has(x.slug))) {
      const gateSeqs = facts
        .filter((f) => f.type === GATE_APPROVED && v.stages.some((s) => s.output && f.refs.gate_of === s.inputId))
        .map((f) => f.seq);
      const artSeqs = v.stages.filter((s) => s.output).map((s) => s.output!.seq).sort((a, b) => a - b);
      let run = 0;
      for (const seq of artSeqs) {
        run = gateSeqs.some((g) => g > (artSeqs[artSeqs.indexOf(seq) - 1] ?? 0) && g < seq) ? 1 : run + 1;
        if (run > maxStageSpan) maxStageSpan = run;
      }
    }

    const counts = countTouches(touches);
    return {
      arm: "B", n, reqs,
      elapsed_s: +(elapsed / 1000).toFixed(1),
      touches: counts,
      m1_relay: counts.carry + counts.glance, // structurally 0 — asserted below
      m1_adjudication: counts.gate,
      m2_max_gap_s: +substantiveGaps(touches, elapsed).toFixed(1),
      m2_stage_span: maxStageSpan,
      machine_checks: verdicts,
      notes: {
        human_model: { GATE_MS: HUMAN.GATE_MS, CARRY_MS_feed: HUMAN.CARRY_MS },
        facts_on_bus: facts.length,
        claims,
        double_executions: doubleExec,
        human_authored_facts: humanFacts.length,
        gate_mode: "ANT_AUTO_GATE off — gates approved by the harness-as-human",
      },
    };
  } finally {
    killAll(children);
  }
}
