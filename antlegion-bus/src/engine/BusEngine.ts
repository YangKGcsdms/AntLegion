/**
 * Bus Core Engine — the heart of antlegion-bus.
 * Mirrors Python: server/bus_engine.py
 *
 * Implements the complete fact bus lifecycle:
 *   - Content integrity verification
 *   - Bus authority signature
 *   - Dual state machine (workflow × epistemic)
 *   - Supersede mechanism
 *   - Corroboration/contradiction
 *   - Background tasks (TTL, GC, compaction)
 *   - Startup recovery from JSONL
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  BusConfig,
  BusEvent,
  BusEventType,
  AntIdentity,
  AntState,
  EpistemicState,
  Fact,
  FactState,
} from "../types/protocol.js";
import {
  createAntIdentity,
  createFact,
  DEFAULT_CONFIG,
  PROTOCOL_VERSION,
} from "../types/protocol.js";
import { transition, canTransition } from "./WorkflowStateMachine.js";
import { recomputeEpistemic } from "./EpistemicStateMachine.js";
import { evaluateFilter, arbitrate } from "./FilterEngine.js";
import { PublishGate, applyAging } from "./FlowControl.js";
import { recordEvent, shouldAcceptPublication, ErrorEvent, type ErrorEventValue } from "./ReliabilityManager.js";
import { computeContentHash } from "./ContentHasher.js";
import { JSONLStore } from "../persistence/JSONLStore.js";

export type EventCallback = (antId: string, event: BusEvent) => void;

const MAX_EVENT_RETRIES = 3;

export class BusEngine {
  // Bus identity & signing
  private busSecret: string;
  private sequenceCounter = 0;

  // Persistence
  private store: JSONLStore;

  // Registries
  private facts = new Map<string, Fact>();
  private ants = new Map<string, AntIdentity>();
  private antConnections = new Map<string, EventCallback>();

  // Indexes
  private activeClaims = new Map<string, number>();
  private subjectIndex = new Map<string, string>(); // "subject_key:fact_type" → fact_id

  // Auth
  private antTokens = new Map<string, string>(); // ant_id → sha256(token)

  // Protocol components
  private publishGate: PublishGate;

  // Config
  private config: BusConfig;

  // Per-ant activity log
  private antActivity = new Map<string, Array<{
    action: string;
    fact_id: string;
    detail: string;
    timestamp: number;
  }>>();
  private readonly maxActivityEntries = 200;

  // Background tasks
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(config?: Partial<BusConfig>) {
    this.config = {
      server: { ...DEFAULT_CONFIG.server, ...config?.server },
      data: { ...DEFAULT_CONFIG.data, ...config?.data },
      bus: { ...DEFAULT_CONFIG.bus, ...config?.bus },
      flow: { ...DEFAULT_CONFIG.flow, ...config?.flow },
      trust: { ...DEFAULT_CONFIG.trust, ...config?.trust },
    };

    this.busSecret =
      process.env.ANTLEGION_BUS_SECRET
      ?? process.env.FACT_BUS_SECRET
      ?? randomBytes(32).toString("hex");

    this.store = new JSONLStore(this.config.data.dir);

    this.publishGate = new PublishGate({
      rateLimitCapacity: this.config.flow.rateLimitCapacity,
      rateLimitRefillRate: this.config.flow.rateLimitRefillRate,
      circuitBreakerWindowSeconds: this.config.flow.circuitBreakerWindowSeconds,
      circuitBreakerThreshold: this.config.flow.circuitBreakerThreshold,
      dedupeWindowSeconds: this.config.flow.dedupeWindowSeconds,
    });

    this.recoverFromStore();
    this.startBackgroundTasks();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private recoverFromStore(): void {
    const entries = this.store.readAll();
    let recovered = 0;

    for (const { fact, event } of entries) {
      if (event === "publish") {
        this.facts.set(fact.fact_id, fact);
        if (fact.subject_key) {
          this.subjectIndex.set(
            `${fact.subject_key}:${fact.fact_type}`,
            fact.fact_id,
          );
        }
      } else if (["claim", "resolve", "dead"].includes(event)) {
        const existing = this.facts.get(fact.fact_id);
        if (existing) {
          existing.state = fact.state;
          existing.claimed_by = fact.claimed_by;
          existing.resolved_at = fact.resolved_at;
        }
      } else if (event === "release") {
        const existing = this.facts.get(fact.fact_id);
        if (existing) {
          existing.state = "published";
          existing.claimed_by = null;
        }
      } else if (event === "redispatch") {
        const existing = this.facts.get(fact.fact_id);
        if (existing) {
          existing.state = fact.state;
          existing.claimed_by = null;
          existing.effective_priority = fact.effective_priority;
          existing.created_at = fact.created_at;
        }
      } else if (event === "purge") {
        const removed = this.facts.get(fact.fact_id);
        if (removed) {
          this.facts.delete(fact.fact_id);
          if (removed.subject_key) {
            const sk = `${removed.subject_key}:${removed.fact_type}`;
            if (this.subjectIndex.get(sk) === fact.fact_id) {
              this.subjectIndex.delete(sk);
            }
          }
        }
      } else if (event === "causation_repair") {
        const existing = this.facts.get(fact.fact_id);
        if (existing) {
          existing.causation_chain = [...fact.causation_chain];
          existing.causation_depth = fact.causation_depth;
        }
      } else if (event === "corroborate") {
        const existing = this.facts.get(fact.fact_id);
        if (existing) {
          existing.corroborations = [...fact.corroborations];
          existing.epistemic_state = fact.epistemic_state;
        }
      } else if (event === "contradict") {
        const existing = this.facts.get(fact.fact_id);
        if (existing) {
          existing.contradictions = [...fact.contradictions];
          existing.epistemic_state = fact.epistemic_state;
        }
      } else if (event === "supersede") {
        const existing = this.facts.get(fact.fact_id);
        if (existing) {
          existing.superseded_by = fact.superseded_by;
          existing.epistemic_state = fact.epistemic_state;
        }
      }
      recovered++;
    }

    // Rebuild active claims
    for (const fact of this.facts.values()) {
      if (
        fact.claimed_by &&
        (fact.state === "claimed" || fact.state === "processing")
      ) {
        this.activeClaims.set(
          fact.claimed_by,
          (this.activeClaims.get(fact.claimed_by) ?? 0) + 1,
        );
      }
    }

    if (recovered > 0) {
      console.log(`[BusEngine] Recovered ${recovered} fact events from store`);
    }
  }

  private startBackgroundTasks(): void {
    // TTL expiration loop (10s)
    this.timers.push(
      setInterval(() => this.expirationTick(), 10_000),
    );
    // Heartbeat timeout check (30s)
    this.timers.push(
      setInterval(() => this.heartbeatTimeoutTick(), 30_000),
    );
    // GC loop (60s)
    this.timers.push(
      setInterval(() => this.gcTick(), 60_000),
    );
    // Compaction loop (3600s)
    this.timers.push(
      setInterval(() => this.compactionTick(), 3600_000),
    );
  }

  /** Stop all background tasks (for graceful shutdown). */
  shutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  // -------------------------------------------------------------------------
  // Background ticks
  // -------------------------------------------------------------------------

  private heartbeatTimeoutTick(): void {
    const now = Date.now() / 1000;
    const timeout = 300; // 10 missed heartbeats — tolerates slow LLM calls up to 5min
    for (const ant of this.ants.values()) {
      if (
        ant.last_heartbeat &&
        now - ant.last_heartbeat > timeout &&
        ant.state !== "offline"
      ) {
        const oldState = ant.state;
        ant.state = "offline";
        this.emitAntStateChanged(ant, oldState);
      }
    }
  }

  private expirationTick(): void {
    const now = Date.now() / 1000;
    for (const fact of this.facts.values()) {
      if (
        (fact.state === "published" || fact.state === "matched") &&
        now > fact.created_at + fact.ttl_seconds
      ) {
        this.markDead(fact, "ttl_expired");
      }
    }
  }

  private gcTick(): void {
    const now = Date.now() / 1000;
    const toDelete = this.gcCollectCandidates(now);
    for (const fid of toDelete) {
      const fact = this.facts.get(fid);
      if (fact) this.store.append(fact, "purge", { reason: "gc" });
      this.facts.delete(fid);
      this.publishGate.chainSignatures.delete(fid);
    }
  }

  private gcCollectCandidates(now: number): string[] {
    const toDelete: string[] = [];
    for (const [fid, fact] of this.facts) {
      if (fact.state === "resolved") {
        const age = now - (fact.resolved_at ?? fact.created_at);
        if (age > this.config.bus.gcRetainResolvedSeconds) toDelete.push(fid);
      } else if (fact.state === "dead") {
        const age = now - fact.created_at;
        if (age > this.config.bus.gcRetainDeadSeconds) toDelete.push(fid);
      }
    }

    const remaining = this.facts.size - toDelete.length;
    if (remaining > this.config.bus.gcMaxFacts) {
      const deleteSet = new Set(toDelete);
      const terminal = [...this.facts.entries()]
        .filter(
          ([fid, f]) =>
            (f.state === "resolved" || f.state === "dead") &&
            !deleteSet.has(fid),
        )
        .sort((a, b) => a[1].created_at - b[1].created_at);

      const overflow = remaining - this.config.bus.gcMaxFacts;
      for (let i = 0; i < Math.min(overflow, terminal.length); i++) {
        toDelete.push(terminal[i][0]);
      }
    }
    return toDelete;
  }

  private compactionTick(): void {
    try {
      this.store.compact(this.facts);
    } catch (err) {
      console.error("[BusEngine] Log compaction failed:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Bus Signing
  // -------------------------------------------------------------------------

  private nextSequence(): number {
    return ++this.sequenceCounter;
  }

  private computeSignature(fact: Fact): string {
    const message = `${fact.fact_id}|${fact.content_hash}|${fact.source_ant_id}|${fact.fact_type}|${fact.created_at}`;
    return createHmac("sha256", this.busSecret)
      .update(message, "utf-8")
      .digest("hex");
  }

  // -------------------------------------------------------------------------
  // Ant Management
  // -------------------------------------------------------------------------

  generateAntToken(antId: string): string {
    const token = randomBytes(24).toString("hex");
    this.antTokens.set(
      antId,
      createHash("sha256").update(token).digest("hex"),
    );
    return token;
  }

  verifyAntToken(antId: string, token: string): boolean {
    const expected = this.antTokens.get(antId);
    if (!expected) return false;
    const provided = createHash("sha256").update(token).digest("hex");
    try {
      return timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(provided, "hex"),
      );
    } catch {
      return false;
    }
  }

  connectAnt(
    antId: string,
    identity: AntIdentity,
    eventCallback: EventCallback,
  ): AntIdentity {
    const now = Date.now() / 1000;
    identity.ant_id = antId;
    identity.connected_at = now;
    identity.last_heartbeat = now;
    identity.state = "active";

    this.ants.set(antId, identity);
    this.antConnections.set(antId, eventCallback);
    this.recordAntEvent(identity, ErrorEvent.HEARTBEAT_OK);

    this.recordActivity(antId, "connect");
    this.replayRecentFacts(antId);

    return identity;
  }

  disconnectAnt(antId: string): void {
    const ant = this.ants.get(antId);
    if (ant) ant.state = "offline";
    this.ants.delete(antId);
    this.antConnections.delete(antId);
    this.antTokens.delete(antId);
    this.recordActivity(antId, "disconnect");
  }

  heartbeat(antId: string, status?: { current_action?: string; status_text?: string }): AntState {
    const ant = this.ants.get(antId);
    if (!ant) return "offline";
    ant.last_heartbeat = Date.now() / 1000;
    if (status?.current_action !== undefined) ant.current_action = status.current_action;
    if (status?.status_text !== undefined) ant.status_text = status.status_text;
    // Restore from offline state on successful heartbeat
    if (ant.state === "offline") {
      const oldState = ant.state;
      ant.state = "active";
      this.emitAntStateChanged(ant, oldState);
    }
    this.recordAntEvent(ant, ErrorEvent.HEARTBEAT_OK);
    return ant.state;
  }

  // -------------------------------------------------------------------------
  // Fact Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Publish a fact onto the bus.
   * Returns [success, reason, factId].
   */
  publishFact(fact: Fact): [boolean, string, string | null] {
    // Step 1-2: Integrity
    const expectedHash = computeContentHash(fact);
    if (fact.content_hash) {
      if (fact.content_hash !== expectedHash) {
        return [false, "content integrity check failed", null];
      }
    } else {
      fact.content_hash = expectedHash;
    }

    // Step 3: Reliability gate
    if (fact.source_ant_id && this.ants.has(fact.source_ant_id)) {
      const ant = this.ants.get(fact.source_ant_id)!;
      const [ok, reason] = shouldAcceptPublication(ant, fact);
      if (!ok) {
        this.recordAntEvent(ant, ErrorEvent.SCHEMA_VIOLATION);
        return [false, reason, null];
      }
    }

    // Step 4: Flow control
    const [flowOk, flowReason] = this.publishGate.check(
      fact,
      this.config.bus.maxCausationDepth,
    );
    if (!flowOk) {
      if (this.ants.has(fact.source_ant_id)) {
        this.recordAntEvent(
          this.ants.get(fact.source_ant_id)!,
          ErrorEvent.RATE_EXCEEDED,
        );
      }
      return [false, flowReason, null];
    }

    // Step 5: Accept — sign and stamp
    transition(fact, "published");
    fact.effective_priority = fact.priority;
    fact.sequence_number = this.nextSequence();
    fact.signature = this.computeSignature(fact);
    fact.epistemic_state = "asserted";

    this.facts.set(fact.fact_id, fact);

    // Step 6: Supersede
    this.handleSupersede(fact);

    // Step 7: Persist
    this.store.append(fact, "publish");

    // Step 8: Dispatch
    this.recordActivity(
      fact.source_ant_id,
      "publish",
      fact.fact_id,
      fact.fact_type,
    );
    this.dispatchFact(fact);

    return [true, "ok", fact.fact_id];
  }

  private handleSupersede(newFact: Fact): void {
    let targetId: string | undefined;

    // Explicit supersede
    if (newFact.supersedes && this.facts.has(newFact.supersedes)) {
      targetId = newFact.supersedes;
    }
    // Auto-supersede by subject_key
    else if (newFact.subject_key) {
      const idxKey = `${newFact.subject_key}:${newFact.fact_type}`;
      const oldId = this.subjectIndex.get(idxKey);
      if (oldId && this.facts.has(oldId) && oldId !== newFact.fact_id) {
        const oldFact = this.facts.get(oldId)!;
        if (oldFact.state !== "resolved" && oldFact.state !== "dead") {
          targetId = oldId;
        }
      }
      this.subjectIndex.set(idxKey, newFact.fact_id);
    }

    if (targetId) {
      const oldFact = this.facts.get(targetId)!;
      oldFact.superseded_by = newFact.fact_id;
      recomputeEpistemic(
        oldFact,
        this.config.trust.consensusQuorum,
        this.config.trust.refutationQuorum,
      );
      this.store.append(oldFact, "supersede", {
        superseded_by: newFact.fact_id,
      });

      for (const ant of this.ants.values()) {
        const match = evaluateFilter(oldFact, ant);
        if (match.matched) {
          this.sendEvent(ant.ant_id, {
            event_type: "fact_superseded",
            fact: oldFact,
            detail: `superseded by ${newFact.fact_id}`,
            timestamp: Date.now() / 1000,
          });
        }
      }
    }
  }

  claimFact(factId: string, antId: string): [boolean, string] {
    const fact = this.facts.get(factId);
    if (!fact) return [false, "fact not found"];

    if (fact.mode !== "exclusive") return [false, "fact is not exclusive mode"];

    if (fact.state !== "published" && fact.state !== "matched") {
      if (fact.claimed_by === antId) return [true, "already claimed by you"];
      if (fact.claimed_by) return [false, `already claimed by ${fact.claimed_by}`];
      return [false, `fact is ${fact.state}`];
    }

    const ant = this.ants.get(antId);
    if (ant) {
      const currentClaims = this.activeClaims.get(antId) ?? 0;
      if (currentClaims >= ant.max_concurrent_claims) {
        return [
          false,
          `ant already has ${currentClaims} active claims (max ${ant.max_concurrent_claims})`,
        ];
      }
    }

    // Atomic: single tick, no await
    transition(fact, "claimed");
    fact.claimed_by = antId;
    this.activeClaims.set(antId, (this.activeClaims.get(antId) ?? 0) + 1);
    this.store.append(fact, "claim", { claimer: antId });

    this.recordActivity(antId, "claim", factId, fact.fact_type);
    this.notifyClaimed(fact, antId);
    return [true, "ok"];
  }

  resolveFact(
    factId: string,
    antId: string,
    resultFacts?: Partial<Fact>[],
  ): [boolean, string] {
    const fact = this.facts.get(factId);
    if (!fact) return [false, "fact not found"];
    if (fact.claimed_by !== antId) {
      return [false, `not claimed by you (claimed by ${fact.claimed_by})`];
    }

    transition(fact, "resolved");
    fact.resolved_at = Date.now() / 1000;

    const claims = this.activeClaims.get(antId) ?? 0;
    if (claims > 0) this.activeClaims.set(antId, claims - 1);

    this.store.append(fact, "resolve", { resolver: antId });

    const ant = this.ants.get(antId);
    if (ant) this.recordAntEvent(ant, ErrorEvent.FACT_RESOLVED);

    this.recordActivity(antId, "resolve", factId, fact.fact_type);

    // Publish child facts
    if (resultFacts) {
      for (const t of resultFacts) {
        const overrides: Partial<Fact> = {
          fact_type: t.fact_type ?? "",
          payload: t.payload ?? {},
          source_ant_id: antId,
          causation_chain: [...fact.causation_chain, fact.fact_id],
          causation_depth: fact.causation_depth + 1,
        };
        if (t.domain_tags !== undefined) overrides.domain_tags = t.domain_tags;
        if (t.need_capabilities !== undefined) overrides.need_capabilities = t.need_capabilities;
        if (t.priority !== undefined) overrides.priority = t.priority;
        if (t.mode !== undefined) overrides.mode = t.mode;
        if (t.semantic_kind !== undefined) overrides.semantic_kind = t.semantic_kind;
        this.publishFact(createFact(overrides));
      }
    }

    return [true, "ok"];
  }

  corroborateFact(factId: string, antId: string): [boolean, string] {
    const fact = this.facts.get(factId);
    if (!fact) return [false, "fact not found"];
    if (antId === fact.source_ant_id) {
      return [false, "cannot corroborate your own fact"];
    }
    if (fact.corroborations.includes(antId)) {
      return [true, fact.epistemic_state];
    }

    fact.corroborations.push(antId);
    const oldState = fact.epistemic_state;
    recomputeEpistemic(
      fact,
      this.config.trust.consensusQuorum,
      this.config.trust.refutationQuorum,
    );

    // TEC reward
    const sourceAnt = this.ants.get(fact.source_ant_id);
    if (sourceAnt) this.recordAntEvent(sourceAnt, ErrorEvent.CORROBORATION);

    this.store.append(fact, "corroborate", {
      by: antId,
      epistemic_state: fact.epistemic_state,
    });

    if (fact.epistemic_state !== oldState) {
      this.notifyTrustChanged(fact, oldState);
    }

    return [true, fact.epistemic_state];
  }

  contradictFact(factId: string, antId: string): [boolean, string] {
    const fact = this.facts.get(factId);
    if (!fact) return [false, "fact not found"];
    if (antId === fact.source_ant_id) {
      return [false, "cannot contradict your own fact"];
    }
    if (fact.contradictions.includes(antId)) {
      return [true, fact.epistemic_state];
    }

    fact.contradictions.push(antId);
    const oldState = fact.epistemic_state;
    recomputeEpistemic(
      fact,
      this.config.trust.consensusQuorum,
      this.config.trust.refutationQuorum,
    );

    const sourceAnt = this.ants.get(fact.source_ant_id);
    if (sourceAnt) this.recordAntEvent(sourceAnt, ErrorEvent.CONTRADICTION);

    this.store.append(fact, "contradict", {
      by: antId,
      epistemic_state: fact.epistemic_state,
    });

    if (fact.epistemic_state !== oldState) {
      this.notifyTrustChanged(fact, oldState);
    }

    return [true, fact.epistemic_state];
  }

  releaseFact(factId: string, antId: string): [boolean, string] {
    const fact = this.facts.get(factId);
    if (!fact) return [false, "fact not found"];
    if (fact.claimed_by !== antId) return [false, "not claimed by you"];

    const claims = this.activeClaims.get(antId) ?? 0;
    if (claims > 0) this.activeClaims.set(antId, claims - 1);

    transition(fact, "published");
    fact.claimed_by = null;

    this.store.append(fact, "release", { releaser: antId });
    this.recordActivity(antId, "release", factId, fact.fact_type);
    // 重新派发时排除刚释放的 ant，防止同一个 ant 反复认领又释放的死循环
    this.dispatchFact(fact, new Set([antId]));
    return [true, "ok"];
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  getFact(factId: string): Fact | undefined {
    return this.facts.get(factId);
  }

  queryFacts(opts?: {
    fact_type?: string;
    state?: FactState;
    source_ant_id?: string;
    limit?: number;
  }): Fact[] {
    const limit = opts?.limit ?? 100;
    const results: Fact[] = [];
    for (const fact of this.facts.values()) {
      if (opts?.fact_type && fact.fact_type !== opts.fact_type) continue;
      if (opts?.state && fact.state !== opts.state) continue;
      if (opts?.source_ant_id && fact.source_ant_id !== opts.source_ant_id) continue;
      results.push(fact);
    }
    return results.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  getAnt(antId: string): AntIdentity | undefined {
    return this.ants.get(antId);
  }

  getAnts(): AntIdentity[] {
    return [...this.ants.values()];
  }

  getCausationChain(factId: string): Fact[] {
    const fact = this.facts.get(factId);
    if (!fact) return [];
    const chain: Fact[] = [];
    for (const ancestorId of fact.causation_chain) {
      const ancestor = this.facts.get(ancestorId);
      if (ancestor) chain.push(ancestor);
    }
    chain.push(fact);
    return chain;
  }

  getStats(): Record<string, unknown> {
    const byState: Record<string, number> = {};
    const byEpistemic: Record<string, number> = {};
    for (const f of this.facts.values()) {
      byState[f.state] = (byState[f.state] ?? 0) + 1;
      byEpistemic[f.epistemic_state] = (byEpistemic[f.epistemic_state] ?? 0) + 1;
    }

    const antsByState: Record<string, number> = {};
    for (const c of this.ants.values()) {
      antsByState[c.state] = (antsByState[c.state] ?? 0) + 1;
    }

    return {
      facts: { total: this.facts.size, by_state: byState, by_epistemic: byEpistemic },
      ants: { connected: this.ants.size, by_state: antsByState },
      store: this.store.getStats(),
      protocol_version: PROTOCOL_VERSION,
    };
  }

  // -------------------------------------------------------------------------
  // Activity log
  // -------------------------------------------------------------------------

  private recordActivity(
    antId: string,
    action: string,
    factId = "",
    detail = "",
  ): void {
    let log = this.antActivity.get(antId);
    if (!log) {
      log = [];
      this.antActivity.set(antId, log);
    }
    log.push({
      action,
      fact_id: factId,
      detail,
      timestamp: Date.now() / 1000,
    });
    if (log.length > this.maxActivityEntries) {
      log.splice(0, log.length - this.maxActivityEntries);
    }
  }

  getAntActivity(antId: string, limit = 50): Array<Record<string, unknown>> {
    const log = this.antActivity.get(antId) ?? [];
    return log.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  adminRunGc(): { removed: number; fact_ids: string[] } {
    const now = Date.now() / 1000;
    const toDelete = this.gcCollectCandidates(now);
    for (const fid of toDelete) {
      const fact = this.facts.get(fid);
      if (fact) this.store.append(fact, "purge", { reason: "admin_gc" });
      this.facts.delete(fid);
      this.publishGate.chainSignatures.delete(fid);
    }
    return { removed: toDelete.length, fact_ids: toDelete };
  }

  adminCompactStore(): { stale_entries_removed: number } {
    const removed = this.store.compact(this.facts);
    return { stale_entries_removed: removed };
  }

  /** Detailed metrics — storage stats + fact-state breakdown + derived rates. */
  getMetrics(): Record<string, unknown> {
    const stats = this.getStats() as {
      facts: { total: number; by_state: Record<string, number> };
      [k: string]: unknown;
    };
    const byState = stats.facts.by_state;
    const total = stats.facts.total;
    return {
      ...stats,
      computed: {
        resolution_rate: (byState.resolved ?? 0) / Math.max(total, 1),
        dead_letter_rate: (byState.dead ?? 0) / Math.max(total, 1),
        active_claims: (byState.claimed ?? 0) + (byState.processing ?? 0),
        pending_facts: (byState.published ?? 0) + (byState.matched ?? 0),
      },
    };
  }

  /** Storage stats. */
  getStorageStats(): Record<string, unknown> {
    return {
      store: this.store.getStats(),
      facts_total: this.facts.size,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: Dispatch and Notifications
  // -------------------------------------------------------------------------

  private dispatchFact(fact: Fact, excludeAntIds?: Set<string>): void {
    const matched: Array<{ ant: AntIdentity; score: number }> = [];

    for (const ant of this.ants.values()) {
      if (excludeAntIds?.has(ant.ant_id)) continue;
      const match = evaluateFilter(fact, ant);
      if (match.matched) matched.push({ ant, score: match.score });
    }

    if (matched.length === 0) return;

    if (fact.state === "published" && canTransition(fact.state, "matched")) {
      transition(fact, "matched");
    }

    let ordered: AntIdentity[];
    if (fact.mode === "exclusive") {
      // exclusive fact 只发给仲裁胜出的单个 ant，避免群魔乱舞
      ordered = arbitrate(fact, matched);
    } else {
      ordered = matched.map((m) => m.ant);
    }

    for (const ant of ordered) {
      this.sendEvent(ant.ant_id, {
        event_type: "fact_available",
        fact,
        timestamp: Date.now() / 1000,
      });
    }
  }

  private notifyClaimed(fact: Fact, claimedBy: string): void {
    for (const ant of this.ants.values()) {
      if (ant.ant_id === claimedBy) continue;
      const match = evaluateFilter(fact, ant);
      if (match.matched) {
        this.sendEvent(ant.ant_id, {
          event_type: "fact_claimed",
          fact,
          ant_id: claimedBy,
          timestamp: Date.now() / 1000,
        });
      }
    }
  }

  private notifyTrustChanged(fact: Fact, oldState: EpistemicState): void {
    for (const ant of this.ants.values()) {
      const match = evaluateFilter(fact, ant);
      if (match.matched) {
        this.sendEvent(ant.ant_id, {
          event_type: "fact_trust_changed",
          fact,
          detail: `${oldState} -> ${fact.epistemic_state}`,
          timestamp: Date.now() / 1000,
        });
      }
    }
  }

  private replayRecentFacts(antId: string): void {
    const ant = this.ants.get(antId);
    if (!ant) return;

    const recent = [...this.facts.values()]
      .filter((f) => f.state === "published" || f.state === "matched")
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, this.config.bus.replayOnReconnect);

    for (const fact of recent.reverse()) {
      const match = evaluateFilter(fact, ant);
      if (match.matched) {
        applyAging(fact);
        this.sendEvent(antId, {
          event_type: "fact_available",
          fact,
          timestamp: Date.now() / 1000,
        });
      }
    }
  }

  private markDead(fact: Fact, reason: string): void {
    if (fact.claimed_by) {
      const claims = this.activeClaims.get(fact.claimed_by) ?? 0;
      if (claims > 0) this.activeClaims.set(fact.claimed_by, claims - 1);
    }

    transition(fact, "dead", true);
    this.store.append(fact, "dead", { reason });

    for (const ant of this.ants.values()) {
      const match = evaluateFilter(fact, ant);
      if (match.matched) {
        this.sendEvent(ant.ant_id, {
          event_type: "fact_dead",
          fact,
          detail: reason,
          timestamp: Date.now() / 1000,
        });
      }
    }

    const sourceAnt = this.ants.get(fact.source_ant_id);
    if (sourceAnt) this.recordAntEvent(sourceAnt, ErrorEvent.FACT_EXPIRED);
  }

  /** Record a reliability event and emit ant_state_changed if state transitions. */
  private recordAntEvent(ant: AntIdentity, event: ErrorEventValue): void {
    const oldState = ant.state;
    recordEvent(ant, event);
    if (ant.state !== oldState) {
      this.emitAntStateChanged(ant, oldState);
    }
  }

  private emitAntStateChanged(ant: AntIdentity, oldState: string): void {
    for (const other of this.ants.values()) {
      this.sendEvent(other.ant_id, {
        event_type: "ant_state_changed",
        ant_id: ant.ant_id,
        detail: `${oldState} -> ${ant.state}`,
        timestamp: Date.now() / 1000,
      });
    }
  }

  private sendEvent(antId: string, event: BusEvent): void {
    const callback = this.antConnections.get(antId);
    if (!callback) return;
    try {
      callback(antId, event);
    } catch (err) {
      console.warn(
        `[BusEngine] Failed to deliver ${event.event_type} to ant ${antId}:`,
        err,
      );
    }
  }
}
