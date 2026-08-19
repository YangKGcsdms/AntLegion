/**
 * v2 folding client SDK (PROTOCOL.md §3 "Where the elegance goes").
 *
 * This is the layer that keeps the client surface small (publish / query /
 * current / supersede / claim / resolve / observe / state / causation /
 * descendants) while the bus stays trivial: it appends,
 * maintains a cursor-synced local mirror, and runs the reader folds so callers
 * see "claim / resolve / state" instead of "append a _.claim fact then read
 * back and fold". The alctl CLI (cli.ts) is a thin shell over this SDK and is
 * the sanctioned interface for external/headless agents.
 */

import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { AppendResult, Fact, FactInput, Refs } from "./types.js";
import { RESERVED } from "./types.js";
import type { BusV2, ReadQuery } from "./bus.js";
import {
  lifecycle, claimWinner, didIWin, trust, causationChain, descendants,
  supersededBy, current, history,
  colony, orphanReport, contextGaps,
  type Lifecycle, type TrustState, type AgentRegistration, type OrphanReport, type ContextGap,
} from "./fold.js";

/**
 * Stable per-user identity: `<os-username>@<hostname>` (e.g. `carter@CartersMacAir`).
 * Unlike a per-process default, it survives across CLI invocations, so the
 * documented claim → resolve flow works out of the box. Override with
 * ANTLEGION_AUTHOR (the alctl `--author` flag / env).
 */
export function defaultAuthor(): string {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname(); // userInfo() can throw when the user has no /etc/passwd entry
  }
}

/** Transport abstraction: the client only needs append + read (+ optional INFO). */
export interface Transport {
  append(input: FactInput): Promise<AppendResult>;
  read(q: ReadQuery): Promise<Fact[]>;
  /** Server INFO payload (the redis INFO analog), when the transport exposes it. */
  info?(): Promise<Record<string, unknown>>;
}

/** In-process transport (tests, embedding) — talks straight to the core. */
export function localTransport(bus: BusV2): Transport {
  return {
    append: async (i) => bus.append(i),
    read: async (q) => [...bus.read(q)],
    info: async () => bus.info(),
  };
}

/** HTTP transport — talks to a v2 server (§2). */
export function httpTransport(baseUrl: string): Transport {
  const base = baseUrl.replace(/\/$/, "");
  // Human-grade connection errors: an unreachable bus should say how to start one,
  // not dump `TypeError: fetch failed`.
  const call = async (fn: () => Promise<Response>): Promise<Response> => {
    try {
      return await fn();
    } catch (err) {
      throw new Error(`cannot reach bus at ${base} — start one with: npm run dev`, { cause: err });
    }
  };
  return {
    append: async (i) => {
      const res = await call(() =>
        fetch(`${base}/facts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(i),
        }));
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
      const res = await call(() => fetch(`${base}/facts?${p.toString()}`));
      if (!res.ok) throw new Error(`read → ${res.status}: ${await res.text()}`); // include body, like append (review L6)
      return (await res.json()) as Fact[];
    },
    info: async () => {
      const res = await call(() => fetch(`${base}/info`));
      if (!res.ok) throw new Error(`info → ${res.status}: ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
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
    readonly author: string = defaultAuthor(),
    opts: { claimTimeout?: number } = {},
  ) {
    this.foldOpts = { claimTimeout: opts.claimTimeout };
  }

  /** A copy of this client bound to a different author (same transport, fresh mirror). */
  as(author: string): ClientV2 {
    return new ClientV2(this.t, author, this.foldOpts);
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

  /** Does the mirrored log contain fact F? (Call after sync().) */
  private has(F: string): boolean {
    return this.mirror.some((f) => f.id === F);
  }

  /** Claim F, then read back to confirm: exactly-once is decided by lowest seq (§3.1). */
  async claim(F: string): Promise<{ won: boolean; winner: string | null }> {
    await this.sync();
    if (!this.has(F)) throw new Error(`fact ${F} not found`);
    await this.t.append({ type: RESERVED.CLAIM, author: this.author, ts: now(), refs: { claim_of: F }, nonce: nonce() });
    await this.sync();
    return { won: didIWin(this.mirror, F, this.author, this.foldOpts), winner: claimWinner(this.mirror, F, this.foldOpts) };
  }

  /**
   * Resolve F. Only honored when you are the current claim winner (§3.1) —
   * verified by read-back BEFORE appending, so a stray resolve never becomes a
   * silent no-op: it throws instead. Optionally emits child facts (causation).
   */
  async resolve(
    F: string,
    children: Array<{ type: string; payload?: Record<string, unknown>; refs?: Refs }> = [],
  ): Promise<{ childIds: string[] }> {
    await this.sync();
    if (!this.has(F)) throw new Error(`fact ${F} not found`);
    const st = lifecycle(this.mirror, F, this.foldOpts);
    if (st.state === "resolved") throw new Error(`resolve ignored — fact ${F} is already resolved`);
    if (st.state !== "claimed" || st.owner !== this.author) {
      throw new Error(st.owner
        ? `resolve ignored — fact ${F} is owned by '${st.owner}' (you are '${this.author}')`
        : `resolve ignored — fact ${F} has no active claim (you are '${this.author}')`);
    }
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

  /** Release your claim on F — throws unless you are the current claim winner. */
  async release(F: string): Promise<void> {
    await this.sync();
    if (!this.has(F)) throw new Error(`fact ${F} not found`);
    const st = lifecycle(this.mirror, F, this.foldOpts);
    if (st.state !== "claimed" || st.owner !== this.author) {
      throw new Error(st.owner
        ? `release ignored — fact ${F} is owned by '${st.owner}' (you are '${this.author}')`
        : `release ignored — fact ${F} has no active claim (you are '${this.author}')`);
    }
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

  /** How F came to be: root→F along `refs.parent` (§3.4). */
  async causation(F: string): Promise<Fact[]> {
    await this.sync();
    return causationChain(this.mirror, F);
  }

  /** What F led to: every transitive child of F, seq-ordered (§3.4, forward). */
  async descendants(F: string): Promise<Fact[]> {
    await this.sync();
    return descendants(this.mirror, F);
  }

  // ── §3.3 subject registers — "what is X right now", identical on every reader ──

  /** The current value of a subject register, or null (never written / retracted). */
  async currentOf(subject: string): Promise<Fact | null> {
    await this.sync();
    return current(this.mirror, subject);
  }

  /** Everything ever said about a subject, oldest first (no latest-wins applied). */
  async historyOf(subject: string): Promise<Fact[]> {
    await this.sync();
    return history(this.mirror, subject);
  }

  /** The id of the fact that replaced F, or null (§3.3). */
  async supersededBy(F: string): Promise<string | null> {
    await this.sync();
    return supersededBy(this.mirror, F);
  }

  /**
   * Replace F with a successor: publish `type` with `refs.supersedes: F`,
   * inheriting F's `refs.subject` (so the register moves with it) unless the
   * caller passes an explicit subject. Any author may supersede — the bus does
   * not adjudicate; the reader's trust fold does (§3.2).
   */
  async supersede(
    F: string,
    type: string,
    payload: Record<string, unknown> = {},
    opts: { refs?: Refs; subject?: string } = {},
  ): Promise<{ id: string; seq: number; deduped: boolean }> {
    await this.sync();
    const target = this.mirror.find((x) => x.id === F);
    if (!target) throw new Error(`fact ${F} not found`);
    const subject = opts.subject ?? target.refs.subject;
    const refs: Refs = { ...opts.refs, supersedes: F, ...(subject ? { subject } : {}) };
    return this.publish(type, payload, { refs, nonce: nonce() });
  }

  /** Retract F: append a `_.tombstone` (§5.2). Deleted is `dead`, never `superseded`. */
  async tombstone(F: string): Promise<{ id: string; seq: number }> {
    await this.sync();
    if (!this.has(F)) throw new Error(`fact ${F} not found`);
    const r = await this.t.append({ type: RESERVED.TOMBSTONE, author: this.author, ts: now(), refs: { tombstones: F }, nonce: nonce() });
    return { id: r.id, seq: r.seq };
  }

  /** §3.5 colony roster — latest sys.registry per agent (interests/publishes). */
  async colony(): Promise<AgentRegistration[]> {
    await this.sync();
    return colony(this.mirror);
  }

  /** §3.5 orphan report — fact types nobody is interested in + declaration gaps. */
  async orphans(): Promise<OrphanReport> {
    await this.sync();
    return orphanReport(this.mirror);
  }

  /** §3.6 open context requests — facts an agent found too thin to act on. */
  async contextGaps(includeAnswered = false): Promise<ContextGap[]> {
    await this.sync();
    return contextGaps(this.mirror, { includeAnswered });
  }

  async query(q: ReadQuery = {}): Promise<Fact[]> {
    return this.t.read(q);
  }

  /** Local view summary after syncing — count of mirrored facts and the cursor head. */
  async snapshot(): Promise<{ facts: number; head_seq: number }> {
    await this.sync();
    return { facts: this.mirror.length, head_seq: this.cursor };
  }

  /** Server INFO (the redis INFO analog); falls back to the local mirror summary. */
  async info(): Promise<Record<string, unknown>> {
    if (this.t.info) return this.t.info();
    return this.snapshot();
  }
}
