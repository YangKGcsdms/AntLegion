/**
 * v2 trusted core (PROTOCOL.md §0.2, §2).
 *
 * The bus does four things and nothing else: assign total order (seq), verify
 * content integrity (id), stamp trusted time (recv) + sign, persist, serve a
 * range. No per-fact mutable state, no state machine — meaning is a reader fold
 * (see fold.ts). The only derived indexes are the seq counter and an id→seq
 * dedup index, both pure projections of the log.
 */

import { randomBytes } from "node:crypto";
import { computeId, computeSig } from "./hash.js";
import { JsonlLog, type FsyncPolicy } from "./log.js";
import { RESERVED, type AppendResult, type Fact, type FactInput } from "./types.js";
import { isSuperseded } from "./fold.js";
import { globMatch } from "./canonical.js";

export interface ReadQuery {
  since?: number;
  limit?: number;
  type?: string;            // glob
  author?: string;
  /** Match a refs key, e.g. { claim_of: "<id>" }. */
  ref?: { key: string; value: string };
}

export class BusV2 {
  private readonly secret: string;
  private readonly secretStable: boolean;
  private readonly log: JsonlLog;
  private readonly facts: Fact[] = [];          // ordered by seq, in-memory projection
  private readonly byId = new Map<string, Fact>(); // id → fact (dedup + lookup)
  private seqCounter = 0;
  private dedupHits = 0;
  private readonly startedAt = Date.now();

  constructor(opts?: { secret?: string; dataDir?: string; fsync?: FsyncPolicy }) {
    const providedSecret = opts?.secret ?? process.env.ANTLEGION_BUS_SECRET;
    this.secretStable = providedSecret != null;
    this.secret = providedSecret ?? randomBytes(32).toString("hex");
    this.log = new JsonlLog(opts?.dataDir, opts?.fsync ?? "always");
    this.recover();
  }

  private recover(): void {
    for (const f of this.log.readAll()) {
      this.facts.push(f);
      this.byId.set(f.id, f);
      if (f.seq > this.seqCounter) this.seqCounter = f.seq;
    }
  }

  /** The single write. Idempotent by id (§4): a repeat returns the existing fact. */
  append(input: FactInput): AppendResult {
    const id = computeId(input);

    if (input.id && input.id !== id) {
      throw new Error(`id mismatch: client sent ${input.id}, computed ${id}`);
    }

    const existing = this.byId.get(id);
    if (existing) {
      this.dedupHits++;
      return { seq: existing.seq, recv: existing.recv, id, sig: existing.sig, deduped: true };
    }

    const seq = ++this.seqCounter;
    const recv = Date.now() / 1000;
    const sig = computeSig(this.secret, {
      id, author: input.author, type: input.type, ts: input.ts, recv, seq,
    });

    const fact: Fact = {
      seq, recv, id,
      type: input.type,
      author: input.author,
      ts: input.ts,
      payload: input.payload ?? {},
      refs: input.refs ?? {},
      ...(input.nonce ? { nonce: input.nonce } : {}),
      sig,
    };

    this.log.append(fact);
    this.facts.push(fact);
    this.byId.set(id, fact);
    return { seq, recv, id, sig, deduped: false };
  }

  /** The single read: a filtered window over the totally-ordered stream. */
  read(q: ReadQuery = {}): Fact[] {
    const since = q.since ?? 0;
    const limit = q.limit ?? 100;
    const out: Fact[] = [];
    for (const f of this.facts) {
      if (f.seq <= since) continue;
      if (q.type && !globMatch(q.type, f.type)) continue;
      if (q.author && f.author !== q.author) continue;
      if (q.ref && f.refs[q.ref.key] !== q.ref.value) continue;
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  }

  get(id: string): Fact | undefined {
    return this.byId.get(id);
  }

  headSeq(): number {
    return this.seqCounter;
  }

  /** All facts (ordered) — used by the fold layer (fold.ts), not a wire endpoint. */
  all(): readonly Fact[] {
    return this.facts;
  }

  /**
   * Compaction (§5.2/§7): drop the payloads of the given fact ids while keeping
   * their full {id, seq, recv, author, refs, sig} skeleton, so folds still work.
   * Returns the number of payloads stripped.
   */
  compact(payloadDroppable: Set<string>): number {
    const stripped = this.log.compact(this.facts, payloadDroppable);
    for (const f of this.facts) {
      if (payloadDroppable.has(f.id)) f.payload = {}; // keep projection == disk
    }
    return stripped;
  }

  /**
   * Rewrite (the BGREWRITEAOF analog): compact by stripping payloads of facts
   * that are tombstoned or superseded — their content no longer matters, only
   * their {id, seq, parent} skeleton (§5.2). Returns payloads stripped.
   */
  rewrite(): number {
    const tombstoned = new Set(
      this.facts.filter((f) => f.type === RESERVED.TOMBSTONE && f.refs.tombstones).map((f) => f.refs.tombstones!),
    );
    const droppable = new Set<string>();
    for (const f of this.facts) {
      if (tombstoned.has(f.id) || isSuperseded(this.facts, f.id)) droppable.add(f.id);
    }
    return this.compact(droppable);
  }

  /** INFO — the operator's window into the bus (the redis INFO analog). */
  info(): Record<string, unknown> {
    const s = this.log.stats();
    return {
      protocol: "2.0",
      head_seq: this.seqCounter,
      facts: this.facts.length,
      log_entries: s.entries,
      log_bytes: s.bytes,
      fsync: this.log.fsyncPolicy,
      dedup_hits: this.dedupHits,
      secret_stable: this.secretStable,
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /** Flush + close the log. Call on graceful shutdown. */
  close(): void {
    this.log.close();
  }
}
