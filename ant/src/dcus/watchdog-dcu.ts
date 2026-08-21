/**
 * dcus/watchdog-dcu.ts — the exception DCU (the supervisor's inbox writer).
 *
 * Listens to EVERYTHING, produces only exceptions: chain.starved and
 * escalate.human. It never claims and never advances the chain — its whole
 * job is turning "something needs a human" into facts the board can fold
 * into the 例外收件箱. Detection is pure (folds/watchdog.ts); this file is
 * just the loop + idempotent publishing.
 */

import type { DCUSpec } from "../runtime.js";
import { colonyAuthor, type IdentityConfig } from "../config.js";
import { foldDevchain } from "../folds/devchain.js";
import {
  CHAIN_STARVED, ESCALATE_HUMAN, WATCHDOG_AUTHOR, STARVED_AFTER_S, ESCALATE_CLAIMS,
  alreadyReported, detectEscalations, detectOrphanRejections, detectStarved,
} from "../folds/watchdog.js";
import { IDENTITY_CONFLICT, detectIdentityConflicts, reportedConflicts } from "../folds/identity.js";
import { foldOpts, publishRegistry } from "./devchain-dcus.js";

export function watchdogDCU(
  busUrl: string, identity?: IdentityConfig, heartbeatSec = 20,
): DCUSpec {
  const author = colonyAuthor(WATCHDOG_AUTHOR, identity?.colony);
  // ≥ 2× the beat so one missed heartbeat is not a false all-clear; with the
  // 20s default a double-start is folded out well inside 60s (验收 3).
  const conflictWindowSec = heartbeatSec * 2;
  return {
    name: author,
    author,
    busUrl,
    pollMs: 2000, // exceptions are slow-moving; no need to race the stage DCUs
    init: async (ctx) => {
      await publishRegistry(busUrl, author, null, {
        role: "watchdog",
        listens: ["*"],
        produces: [CHAIN_STARVED, ESCALATE_HUMAN, IDENTITY_CONFLICT],
        rules: {
          starved: `阶段 open 超 ${STARVED_AFTER_S}s 无人认领`,
          claim_churn: `同一输入 ≥${ESCALATE_CLAIMS} 次认领全部过期`,
          evidence_rejected: "artifact 证据被裁决拒绝（含游离 artifact）",
          identity_conflict: `同 author 双 instance 心跳共存于 ${conflictWindowSec}s 窗口`,
        },
      }, ctx.log, identity);
    },
    onBatch: async (_batch, ctx) => {
      const views = foldDevchain(ctx.mirror, foldOpts(ctx));
      const reported = alreadyReported(ctx.mirror);
      const nowSec = Date.now() / 1000;

      for (const s of detectStarved(ctx.mirror, views, nowSec)) {
        if (reported.has(s.inputId)) continue;
        await ctx.client.publish(CHAIN_STARVED,
          { reqSlug: s.reqSlug, stage: s.stage, openForS: s.openForS },
          { refs: { starves: s.inputId } });
        ctx.log(`STARVED ${s.reqSlug}/${s.stage} — open ${s.openForS}s with no claim`);
      }

      for (const e of [...detectEscalations(ctx.mirror, views), ...detectOrphanRejections(ctx.mirror, views)]) {
        if (reported.has(e.factId)) continue;
        reported.add(e.factId); // the two detectors can overlap on one artifact
        await ctx.client.publish(ESCALATE_HUMAN,
          { reqSlug: e.reqSlug, stage: e.stage, reason: e.reason, detail: e.detail },
          { refs: { escalates: e.factId } });
        ctx.log(`ESCALATE ${e.reqSlug}/${e.stage} — ${e.reason}: ${e.detail}`);
      }

      // 双开检测 (计划 13 §三.3): same author, two live instance tokens →
      // one conflict fact per pair, ever (fold-deduped, restart-safe).
      const knownPairs = reportedConflicts(ctx.mirror);
      for (const c of detectIdentityConflicts(ctx.mirror, conflictWindowSec, nowSec)) {
        if (knownPairs.has(c.pairKey)) continue;
        await ctx.client.publish(IDENTITY_CONFLICT,
          { author: c.author, tokens: c.tokens, pair_key: c.pairKey, window_s: conflictWindowSec },
          { refs: { subject: c.heartbeats[0], conflicts_with: c.heartbeats[1] } });
        ctx.log(`IDENTITY CONFLICT — ${c.author} is double-started (tokens ${c.tokens[0].slice(0, 8)}…/${c.tokens[1].slice(0, 8)}…)`);
      }
    },
  };
}
