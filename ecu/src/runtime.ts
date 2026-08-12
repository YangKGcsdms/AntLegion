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

import { ClientV2, httpTransport } from "antlegion-bus/client";
import type { Fact } from "antlegion-bus/types";

export interface DCUContext {
  client: ClientV2;
  busUrl: string;
  /** Full mirrored stream since boot (or since last bus-restart reset). */
  mirror: Fact[];
  log: (msg: string) => void;
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

export async function runDCU(spec: DCUSpec): Promise<void> {
  const pollMs = spec.pollMs ?? 1000;
  const pageSize = spec.pageSize ?? 500;
  const client = new ClientV2(httpTransport(spec.busUrl), spec.author);
  const log = (msg: string) => console.error(`[${spec.name}] ${new Date().toISOString()} ${msg}`);

  let cursor = 0;
  const mirror: Fact[] = [];
  let stopping = false;
  let down = false;

  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} — stopping after current batch`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const ctx: DCUContext = { client, busUrl: spec.busUrl, mirror, log };

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

  log(`stopped — cursor ${cursor}, mirror ${mirror.length} facts`);
}
