/**
 * runtime.ts — the DCU loop primitive.
 *
 * One loop, five steps, forever:
 *
 *   poll(since cursor) → rebuild shared fold → evaluate triggers → act → advance cursor
 *
 * Deterministic, no LLM. The bus is the only source of truth; the DCU keeps a
 * mirrored window of the stream and re-folds it on every batch. When the bus
 * is unreachable the loop backs off and reconnects; when the bus restarts
 * from an empty journal (head < cursor) the mirror resets and `init` re-runs.
 */

import { randomUUID } from "node:crypto";
import { ClientV2, httpTransport } from "@antlegion/bus/client";
import type { Fact } from "@antlegion/bus/types";

/** Heartbeat fact type — instance liveness, the identity-conflict fold's input. */
export const SYS_HEARTBEAT = "sys.heartbeat";

export interface DCUContext {
  client: ClientV2;
  busUrl: string;
  /** Full mirrored stream since boot (or since last bus-restart reset). */
  mirror: Fact[];
  log: (msg: string) => void;
  /**
   * Δ, the claim timeout in seconds, **as published by the bus** (`/info`).
   *
   * PROTOCOL.md §8.4 makes this a property of the log rather than of the
   * reader: a DCU that folds with its own Δ is non-conforming, and it does not
   * merely disagree about who holds a claim — it disagrees about whether the
   * work was resolved at all. Every fold in this package takes it from here.
   */
  claimTimeout: number;
}

export interface DCUSpec {
  /** DCU name, used in log lines. */
  name: string;
  /** Fact author for everything this DCU publishes. */
  author: string;
  busUrl: string;
  /** Poll interval in ms (default 1000). */
  pollMs?: number;
  /** Read page size (default 500). */
  pageSize?: number;
  /**
   * sys.heartbeat interval in seconds (default 20; 0 disables). Each beat
   * carries this process's random boot token — same author + two live tokens
   * is how a double-started identity gets FOLDED OUT (计划 13 §三.3:
   * 检测代替禁止). Conflict window = 2× this.
   */
  heartbeatSec?: number;
  /**
   * Cold start, and re-run after a bus restart (head < cursor). Use it for
   * backfills — publishes here must be idempotent (stable nonces).
   */
  init?: (ctx: DCUContext) => Promise<void>;
  /**
   * Called after each successful poll with the facts newly appended since
   * the last batch (empty when nothing changed). `ctx.mirror` is already
   * up to date — rebuild folds from it, evaluate triggers, act.
   * Optional: pure producers (e.g. the ingestor) may omit it.
   */
  onBatch?: (batch: Fact[], ctx: DCUContext) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── shared shutdown fan-out (review L2) ──
// A fleet runs many DCUs in one process. Registering a SIGINT/SIGTERM pair
// *per* runDCU meant N DCUs installed 2N listeners → Node's
// MaxListenersExceededWarning at >10. Instead each DCU registers a stopper
// here and the process-level handlers are attached exactly once.
const stoppers = new Set<() => void>();
let signalsWired = false;
function wireSignalsOnce(): void {
  if (signalsWired) return;
  signalsWired = true;
  const fanout = () => { for (const s of stoppers) s(); };
  process.on("SIGINT", fanout);
  process.on("SIGTERM", fanout);
}

/** §B default, used only until the bus's `/info` answers. */
const PROTOCOL_DEFAULT_DELTA = 600;

/**
 * Take Δ from the bus (§8.4, §7.5). A failure here is not fatal — the DCU loop
 * retries the bus anyway — so we fall back to the §B default and say so.
 *
 * `ANT_CLAIM_DELTA` used to set Δ per reader. v3.0 forbids that: two readers
 * folding one stream with different Δ disagree about whether work is resolved.
 * The knob moved to the bus, so an operator who still sets it is told where.
 */
export async function adoptClaimTimeout(
  ctx: DCUContext, busUrl: string, log: (msg: string) => void,
): Promise<void> {
  if (process.env.ANT_CLAIM_DELTA) {
    log("ANT_CLAIM_DELTA is ignored — since protocol v3.0 (§8.4) Δ is a property " +
        "of the log, not of the reader. Set it on the bus instead.");
  }
  try {
    const res = await fetch(`${busUrl.replace(/\/$/, "")}/info`);
    if (!res.ok) throw new Error(`info → ${res.status}`);
    const info = (await res.json()) as { claim_timeout?: unknown };
    if (typeof info.claim_timeout === "number" && Number.isFinite(info.claim_timeout) && info.claim_timeout > 0) {
      ctx.claimTimeout = info.claim_timeout;
      return;
    }
    log(`bus published no usable Δ — folding with the §B default of ${PROTOCOL_DEFAULT_DELTA}s`);
  } catch (err) {
    log(`could not read Δ from the bus (${err instanceof Error ? err.message : String(err)}) — ` +
        `folding with the §B default of ${PROTOCOL_DEFAULT_DELTA}s`);
  }
}

export async function runDCU(spec: DCUSpec): Promise<void> {
  const pollMs = spec.pollMs ?? 1000;
  const pageSize = spec.pageSize ?? 500;
  // Δ is the log's, not ours (§8.4). The client adopts the published value on
  // its first sync; `ctx.claimTimeout` below carries the same number to the
  // folds this package runs directly, so the two can never drift apart.
  const client = new ClientV2(httpTransport(spec.busUrl), spec.author);
  const log = (msg: string) => console.error(`[${spec.name}] ${new Date().toISOString()} ${msg}`);

  let cursor = 0;
  const mirror: Fact[] = [];
  let stopping = false;
  let down = false;
  // Boot instance token: minted per loop start, never part of the author —
  // it lives in heartbeat payloads so readers can fold out double-starts.
  const instance = randomUUID();
  const heartbeatMs = (spec.heartbeatSec ?? 20) * 1000;
  let lastBeat = 0;
  let beatN = 0;

  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} — stopping after current batch`);
  };
  // Register this DCU's stopper with the shared process-level signal handlers
  // (attached once, no matter how many DCUs run in this process — review L2).
  const stopper = () => stop("signal");
  stoppers.add(stopper);
  wireSignalsOnce();

  const ctx: DCUContext = {
    client, busUrl: spec.busUrl, mirror, log,
    claimTimeout: PROTOCOL_DEFAULT_DELTA, // replaced by the bus's value below
  };
  await adoptClaimTimeout(ctx, spec.busUrl, log);

  // Cold start happens once the bus is reachable; retried inside the loop.
  let initialized = false;

  log(`starting — bus ${spec.busUrl}, author ${spec.author}, poll ${pollMs}ms`);

  while (!stopping) {
    try {
      // Bus restart detection: head fell behind our cursor → journal was
      // reset; drop the mirror and re-run cold start.
      const headRes = await fetch(`${spec.busUrl.replace(/\/$/, "")}/facts/head`);
      if (!headRes.ok) throw new Error(`head → ${headRes.status}`);
      const { head_seq } = (await headRes.json()) as { head_seq: number };
      if (head_seq < cursor) {
        log(`bus restarted (head ${head_seq} < cursor ${cursor}) — resetting mirror`);
        cursor = 0;
        mirror.length = 0;
        initialized = false;
      }

      const batch: Fact[] = [];
      for (;;) {
        const page = await client.query({ since: cursor, limit: pageSize });
        if (page.length === 0) break;
        for (const f of page) {
          batch.push(f);
          mirror.push(f);
          if (f.seq > cursor) cursor = f.seq;
        }
        if (page.length < pageSize) break;
      }

      if (down) {
        log(`reconnected — cursor ${cursor}, mirror ${mirror.length} facts`);
        down = false;
      }

      if (!initialized) {
        initialized = true;
        if (spec.init) await spec.init(ctx);
      }

      // Heartbeat on the poll beat (not a timer): it shares the loop's
      // failure handling, and a wedged loop correctly stops beating.
      if (heartbeatMs > 0 && Date.now() - lastBeat >= heartbeatMs) {
        lastBeat = Date.now();
        await client.publish(SYS_HEARTBEAT, { instance, n: ++beatN });
      }

      await spec.onBatch?.(batch, ctx);
    } catch (err) {
      if (stopping) break;
      if (!down) {
        down = true;
        log(`bus unreachable (${err instanceof Error ? err.message : String(err)}) — retrying every ${pollMs}ms`);
      }
    }
    await sleep(pollMs);
  }

  stoppers.delete(stopper); // don't leak this DCU's stopper after it returns
  log(`stopped — cursor ${cursor}, mirror ${mirror.length} facts`);
}
