/**
 * dcus/gate-approver.ts — auto-approve human gates for autonomous runs.
 *
 * The dev-chain parks at H1 (方案评审) until a human publishes gate.approved.
 * For unattended runs (MVP throughput, CI, demos) this DCU folds the shared
 * worldview and approves any gated stage it sees. It is still a DCU — same
 * loop, same fold, publishes facts under its own identity — so the audit
 * trail shows exactly who approved every gate.
 *
 * Enabled only when the fleet is built with { autoGate: true }
 * (ANT_AUTO_GATE=1). Default fleets keep gates human.
 */

import type { DCUSpec } from "../runtime.js";
import { GATE_APPROVED, SYS_REGISTRY, foldDevchain } from "../folds/devchain.js";
import { foldOpts } from "./devchain-dcus.js";
import { httpTransport } from "@antlegion/bus/client";

export const GATE_APPROVER_AUTHOR = "dcu-gate-approver@devchain";

export function gateApproverDCU(busUrl: string): DCUSpec {
  const approved = new Set<string>(); // inputIds approved this session (belt; the fold is suspenders)
  return {
    name: GATE_APPROVER_AUTHOR,
    author: GATE_APPROVER_AUTHOR,
    busUrl,
    pollMs: 1000,
    init: async (ctx) => {
      const r = await httpTransport(busUrl).append({
        type: SYS_REGISTRY,
        author: GATE_APPROVER_AUTHOR,
        ts: 0,
        payload: {
          domain: "devchain",
          dcu: GATE_APPROVER_AUTHOR,
          role: "gate-approver",
          worker: "deterministic",
          listens: ["*gated stages*"],
          produces: [GATE_APPROVED],
          note: "auto-approves human gates — unattended runs only",
        },
        nonce: `registry:devchain:${GATE_APPROVER_AUTHOR}:v1`,
      });
      ctx.log(`registry ${r.deduped ? "deduped" : "published"} (seq ${r.seq})`);
    },
    onBatch: async (_batch, ctx) => {
      for (const req of foldDevchain(ctx.mirror, foldOpts())) {
        for (const stage of req.stages) {
          if (stage.state !== "gated" || !stage.inputId || approved.has(stage.inputId)) continue;
          // Publish FIRST, mark the in-session dedup Set only on success. Marking
          // before the await (the original bug, review M1) meant a transient bus
          // error left the id in `approved` forever: the fold stays `gated`, but
          // `approved.has()` short-circuits every future retry → the gate wedges.
          // The fold is the real dedup (an approved stage is no longer `gated`);
          // this Set is only an in-session fast-path, so it must never persist an
          // approval that did not actually land on the bus.
          await ctx.client.publish(GATE_APPROVED, {
            gate: stage.gate?.name ?? "H1",
            reqSlug: req.slug,
            note: "auto-approved (unattended run)",
          }, { refs: { gate_of: stage.inputId } });
          approved.add(stage.inputId);
          ctx.log(`auto-approved ${stage.gate?.name ?? "H1"} of ${req.slug}`);
        }
      }
    },
  };
}
