/**
 * v2 folding client SDK (PROTOCOL.md §3 "Where the elegance goes").
 *
 * This is the layer that keeps the client surface as simple as v1's MCP tools
 * while the bus stays trivial: it appends, maintains a cursor-synced local
 * mirror, and runs the reader folds so callers see "claim / resolve / state"
 * instead of "append a _.claim fact then read back and fold".
 */

import { randomBytes } from "node:crypto";
import type { AppendResult, Fact, FactInput, Refs } from "./types.js";
import { RESERVED } from "./types.js";
import type { BusV2, ReadQuery } from "./bus.js";
import {
  lifecycle, claimWinner, didIWin, trust, causationChain,
  type Lifecycle, type TrustState,
} from "./fold.js";

/** Transport abstraction: the client only needs append + read. */
export interface Transport {
  append(input: FactInput): Promise<AppendResult>;
  read(q: ReadQuery): Promise<Fact[]>;
}

/** In-process transport (tests, embedding) — talks straight to the core. */
export function localTransport(bus: BusV2): Transport {
  return {
    append: async (i) => bus.append(i),
    read: async (q) => [...bus.read(q)],
  };
}

/** HTTP transport — talks to a v2 server (§2). */
export function httpTransport(baseUrl: string): Transport {
  const base = baseUrl.replace(/\/$/, "");
  return {
    append: async (i) => {
      const res = await fetch(`${base}/facts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(i),
      });
      if (!res.ok) throw new Error(`append → ${res.status}: ${await res.text()}`);
      return (await res.json()) as AppendResult;
    },
    read: async (q) => {
      const p = new URLSearchParams();
      if (q.since != null) p.set("since", String(q.since));
      if (q.limit != null) p.set("limit", String(q.limit));
      if (q.type) p.set("type", q.type);
      if (q.author) p.set("author", q.author);
      if (q.ref) p.set(`refs.${q.ref.key}`, q.ref.value);
      const res = await fetch(`${base}/facts?${p.toString()}`);
      if (!res.ok) throw new Error(`read → ${res.status}`);
      return (await res.json()) as Fact[];
    },
  };
}

const nonce = () => randomBytes(8).toString("hex");
const now = () => Date.now() / 1000;

export class ClientV2 {
  private mirror: Fact[] = [];
  private cursor = 0;
  private readonly foldOpts: { claimTimeout?: number };

  constructor(
    private readonly t: Transport,
    readonly author: string,
    opts: { claimTimeout?: number } = {},
  ) {
    this.foldOpts = { claimTimeout: opts.claimTimeout };
  }

  /** Drain new facts into the local mirror up to the current head. */
  async sync(): Promise<void> {
    for (;;) {
      const batch = await this.t.read({ since: this.cursor, limit: 500 });
      if (batch.length === 0) break;
      for (const f of batch) {
        this.mirror.push(f);
        if (f.seq > this.cursor) this.cursor = f.seq;
      }
      if (batch.length < 500) break;
    }
  }

  async publish(
    type: string,
    payload: Record<string, unknown> = {},
    opts: { refs?: Refs; nonce?: string } = {},
  ): Promise<{ id: string; seq: number; deduped: boolean }> {
    const r = await this.t.append({ type, author: this.author, ts: now(), payload, refs: opts.refs, nonce: opts.nonce });
    return { id: r.id, seq: r.seq, deduped: r.deduped };
  }

  /** Claim F, then read back to confirm: exactly-once is decided by lowest seq (§3.1). */
  async claim(F: string): Promise<{ won: boolean; winner: string | null }> {
    await this.t.append({ type: RESERVED.CLAIM, author: this.author, ts: now(), refs: { claim_of: F }, nonce: nonce() });
    await this.sync();
    return { won: didIWin(this.mirror, F, this.author, this.foldOpts), winner: claimWinner(this.mirror, F, this.foldOpts) };
  }

  /** Resolve F (only effective if you are the winner, §3.1). Optionally emit child facts (causation). */
  async resolve(
    F: string,
    children: Array<{ type: string; payload?: Record<string, unknown>; refs?: Refs }> = [],
  ): Promise<{ childIds: string[] }> {
    await this.t.append({ type: RESERVED.RESOLVE, author: this.author, ts: now(), refs: { resolves: F }, nonce: nonce() });
    const childIds: string[] = [];
    for (const c of children) {
      const r = await this.t.append({
        type: c.type, author: this.author, ts: now(), payload: c.payload ?? {},
        refs: { parent: F, ...c.refs }, nonce: nonce(),
      });
      childIds.push(r.id);
    }
    return { childIds };
  }

  async release(F: string): Promise<void> {
    await this.t.append({ type: RESERVED.RELEASE, author: this.author, ts: now(), refs: { release_of: F }, nonce: nonce() });
  }

  async observe(F: string, verdict: "corroborate" | "contradict"): Promise<void> {
    await this.t.append({ type: RESERVED.VOTE, author: this.author, ts: now(), payload: { verdict }, refs: { vote: F }, nonce: nonce() });
  }

  async state(F: string): Promise<Lifecycle> {
    await this.sync();
    return lifecycle(this.mirror, F, this.foldOpts);
  }

  async trustOf(F: string, quorum?: number): Promise<TrustState> {
    await this.sync();
    return trust(this.mirror, F, quorum);
  }

  async causation(F: string): Promise<Fact[]> {
    await this.sync();
    return causationChain(this.mirror, F);
  }

  async query(q: ReadQuery = {}): Promise<Fact[]> {
    return this.t.read(q);
  }

  /** Local view summary after syncing — count of mirrored facts and the cursor head. */
  async snapshot(): Promise<{ facts: number; head_seq: number }> {
    await this.sync();
    return { facts: this.mirror.length, head_seq: this.cursor };
  }
}
