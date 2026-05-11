import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { BusEngine } from "../src/engine/BusEngine.js";
import {
  createFact,
  createAntIdentity,
  createAcceptanceFilter,
  Priority,
  PROTOCOL_VERSION,
} from "../src/types/protocol.js";
import type { BusEvent, Fact } from "../src/types/protocol.js";
import { computeContentHash } from "../src/engine/ContentHasher.js";

const TEST_DIR = ".data-engine-test";

function makeEngine() {
  return new BusEngine({
    data: { dir: TEST_DIR },
    server: { port: 0, host: "127.0.0.1" },
    bus: {
      maxCausationDepth: 16,
      defaultTtlSeconds: 300,
      gcRetainResolvedSeconds: 600,
      gcRetainDeadSeconds: 3600,
      gcMaxFacts: 10000,
      replayOnReconnect: 50,
    },
    flow: {
      dedupeWindowSeconds: 10,
      rateLimitCapacity: 100,
      rateLimitRefillRate: 100,
      circuitBreakerWindowSeconds: 5,
      circuitBreakerThreshold: 1000,
    },
    trust: { consensusQuorum: 2, refutationQuorum: 2 },
  });
}

function publishableFact(overrides: Partial<Fact> = {}): Fact {
  const fact = createFact({
    fact_type: "test.event",
    payload: { key: "value" },
    source_ant_id: "ant-src",
    mode: "exclusive",
    ...overrides,
  });
  fact.content_hash = computeContentHash(fact);
  return fact;
}

describe("BusEngine", () => {
  let engine: BusEngine;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    engine = makeEngine();
  });

  afterEach(() => {
    engine.shutdown();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Ant management
  // -----------------------------------------------------------------------

  describe("Ant management", () => {
    it("connects and disconnects a ant", () => {
      const identity = createAntIdentity({ name: "reviewer" });
      const token = engine.generateAntToken("ant-1");
      expect(engine.verifyAntToken("ant-1", token)).toBe(true);
      expect(engine.verifyAntToken("ant-1", "wrong")).toBe(false);

      const ant = engine.connectAnt("ant-1", identity, () => {});
      expect(ant.state).toBe("active");
      expect(ant.ant_id).toBe("ant-1");
      expect(engine.getAnt("ant-1")).toBeDefined();

      engine.disconnectAnt("ant-1");
      expect(engine.getAnt("ant-1")).toBeUndefined();
    });

    it("heartbeat updates state", () => {
      const identity = createAntIdentity();
      engine.connectAnt("ant-1", identity, () => {});
      const state = engine.heartbeat("ant-1");
      expect(state).toBe("active");

      expect(engine.heartbeat("nonexistent")).toBe("offline");
    });
  });

  // -----------------------------------------------------------------------
  // Publish pipeline
  // -----------------------------------------------------------------------

  describe("Publish", () => {
    it("publishes a valid fact", () => {
      const fact = publishableFact();
      const [ok, reason, factId] = engine.publishFact(fact);
      expect(ok).toBe(true);
      expect(reason).toBe("ok");
      expect(factId).toBe(fact.fact_id);

      const stored = engine.getFact(fact.fact_id);
      expect(stored).toBeDefined();
      expect(stored!.state).toBe("published");
      expect(stored!.signature).toBeTruthy();
      expect(stored!.sequence_number).toBeGreaterThan(0);
    });

    it("rejects bad content hash", () => {
      const fact = publishableFact();
      fact.content_hash = "0".repeat(64);
      const [ok, reason] = engine.publishFact(fact);
      expect(ok).toBe(false);
      expect(reason).toContain("integrity");
    });

    it("auto-computes content hash if empty", () => {
      const fact = publishableFact();
      fact.content_hash = "";
      const [ok] = engine.publishFact(fact);
      expect(ok).toBe(true);
      expect(engine.getFact(fact.fact_id)!.content_hash).toBeTruthy();
    });

    it("dispatches to connected ants", () => {
      const events: BusEvent[] = [];
      const identity = createAntIdentity({
        acceptance_filter: createAcceptanceFilter(),
      });
      engine.connectAnt("ant-recv", identity, (_, evt) => events.push(evt));

      const fact = publishableFact();
      engine.publishFact(fact);

      // fact_available from replay + from publish
      const available = events.filter((e) => e.event_type === "fact_available");
      expect(available.length).toBeGreaterThanOrEqual(1);
    });

    it("fact becomes matched when ants exist", () => {
      engine.connectAnt("ant-recv", createAntIdentity(), () => {});
      const fact = publishableFact();
      engine.publishFact(fact);

      const stored = engine.getFact(fact.fact_id);
      expect(stored!.state).toBe("matched");
    });
  });

  // -----------------------------------------------------------------------
  // Claim → Resolve lifecycle
  // -----------------------------------------------------------------------

  describe("Claim and Resolve", () => {
    it("claim → resolve full lifecycle", () => {
      const fact = publishableFact();
      engine.publishFact(fact);

      const [claimOk, claimReason] = engine.claimFact(fact.fact_id, "ant-worker");
      expect(claimOk).toBe(true);
      expect(engine.getFact(fact.fact_id)!.state).toBe("claimed");
      expect(engine.getFact(fact.fact_id)!.claimed_by).toBe("ant-worker");

      const [resolveOk] = engine.resolveFact(fact.fact_id, "ant-worker");
      expect(resolveOk).toBe(true);
      expect(engine.getFact(fact.fact_id)!.state).toBe("resolved");
      expect(engine.getFact(fact.fact_id)!.resolved_at).toBeTruthy();
    });

    it("rejects claim on broadcast fact", () => {
      const fact = publishableFact({ mode: "broadcast" });
      engine.publishFact(fact);
      const [ok, reason] = engine.claimFact(fact.fact_id, "ant-1");
      expect(ok).toBe(false);
      expect(reason).toContain("not exclusive");
    });

    it("rejects claim from wrong state", () => {
      const fact = publishableFact();
      engine.publishFact(fact);
      engine.claimFact(fact.fact_id, "w1");
      engine.resolveFact(fact.fact_id, "w1");

      const [ok, reason] = engine.claimFact(fact.fact_id, "w2");
      expect(ok).toBe(false);
    });

    it("enforces max_concurrent_claims", () => {
      const identity = createAntIdentity({ max_concurrent_claims: 1 });
      engine.connectAnt("ant-w", identity, () => {});

      const f1 = publishableFact({ payload: { id: 1 } });
      const f2 = publishableFact({ payload: { id: 2 } });
      // Recompute hashes after payload change to avoid dedup
      f1.content_hash = computeContentHash(f1);
      f2.content_hash = computeContentHash(f2);
      engine.publishFact(f1);
      engine.publishFact(f2);

      engine.claimFact(f1.fact_id, "ant-w");
      const [ok, reason] = engine.claimFact(f2.fact_id, "ant-w");
      expect(ok).toBe(false);
      expect(reason).toContain("active claims");
    });

    it("resolve rejects if not claimed by requester", () => {
      const fact = publishableFact();
      engine.publishFact(fact);
      engine.claimFact(fact.fact_id, "w1");

      const [ok, reason] = engine.resolveFact(fact.fact_id, "w2");
      expect(ok).toBe(false);
      expect(reason).toContain("not claimed by you");
    });

    it("resolve publishes child facts", () => {
      const parent = publishableFact();
      engine.publishFact(parent);
      engine.claimFact(parent.fact_id, "w1");

      engine.resolveFact(parent.fact_id, "w1", [
        {
          fact_type: "child.result",
          payload: { result: "done" },
          mode: "broadcast",
        },
      ]);

      const children = engine.queryFacts({ fact_type: "child.result" });
      expect(children).toHaveLength(1);
      expect(children[0].causation_chain).toContain(parent.fact_id);
      expect(children[0].causation_depth).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Release
  // -----------------------------------------------------------------------

  describe("Release", () => {
    it("releases claimed fact back to published", () => {
      const fact = publishableFact();
      engine.publishFact(fact);
      engine.claimFact(fact.fact_id, "w1");

      const [ok] = engine.releaseFact(fact.fact_id, "w1");
      expect(ok).toBe(true);
      expect(engine.getFact(fact.fact_id)!.state).toBe("published");
      expect(engine.getFact(fact.fact_id)!.claimed_by).toBeNull();
    });

    it("rejects release by wrong ant", () => {
      const fact = publishableFact();
      engine.publishFact(fact);
      engine.claimFact(fact.fact_id, "w1");

      const [ok] = engine.releaseFact(fact.fact_id, "w2");
      expect(ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Corroborate / Contradict
  // -----------------------------------------------------------------------

  describe("Epistemic lifecycle", () => {
    it("corroborate ×2 → consensus", () => {
      const fact = publishableFact({ source_ant_id: "src" });
      engine.publishFact(fact);

      engine.corroborateFact(fact.fact_id, "ant-a");
      expect(engine.getFact(fact.fact_id)!.epistemic_state).toBe("corroborated");

      engine.corroborateFact(fact.fact_id, "ant-b");
      expect(engine.getFact(fact.fact_id)!.epistemic_state).toBe("consensus");
    });

    it("contradict ×2 → refuted", () => {
      const fact = publishableFact({ source_ant_id: "src" });
      engine.publishFact(fact);

      engine.contradictFact(fact.fact_id, "ant-x");
      expect(engine.getFact(fact.fact_id)!.epistemic_state).toBe("contested");

      engine.contradictFact(fact.fact_id, "ant-y");
      expect(engine.getFact(fact.fact_id)!.epistemic_state).toBe("refuted");
    });

    it("cannot corroborate own fact", () => {
      const fact = publishableFact({ source_ant_id: "src" });
      engine.publishFact(fact);
      const [ok] = engine.corroborateFact(fact.fact_id, "src");
      expect(ok).toBe(false);
    });

    it("cannot contradict own fact", () => {
      const fact = publishableFact({ source_ant_id: "src" });
      engine.publishFact(fact);
      const [ok] = engine.contradictFact(fact.fact_id, "src");
      expect(ok).toBe(false);
    });

    it("duplicate corroboration is idempotent", () => {
      const fact = publishableFact({ source_ant_id: "src" });
      engine.publishFact(fact);
      engine.corroborateFact(fact.fact_id, "ant-a");
      const [ok, state] = engine.corroborateFact(fact.fact_id, "ant-a");
      expect(ok).toBe(true);
      expect(engine.getFact(fact.fact_id)!.corroborations).toEqual(["ant-a"]);
    });

    it("notifies trust change", () => {
      const events: BusEvent[] = [];
      engine.connectAnt("obs", createAntIdentity(), (_, e) => events.push(e));

      const fact = publishableFact({ source_ant_id: "src" });
      engine.publishFact(fact);
      events.length = 0; // clear initial events

      engine.corroborateFact(fact.fact_id, "ant-a");
      const trustEvents = events.filter(
        (e) => e.event_type === "fact_trust_changed",
      );
      expect(trustEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Supersede
  // -----------------------------------------------------------------------

  describe("Supersede", () => {
    it("explicit supersede", () => {
      const old = publishableFact({ source_ant_id: "src" });
      engine.publishFact(old);

      const newer = publishableFact({
        source_ant_id: "src",
        supersedes: old.fact_id,
      });
      engine.publishFact(newer);

      expect(engine.getFact(old.fact_id)!.superseded_by).toBe(newer.fact_id);
      expect(engine.getFact(old.fact_id)!.epistemic_state).toBe("superseded");
    });

    it("auto-supersede by subject_key", () => {
      const f1 = publishableFact({
        source_ant_id: "src",
        subject_key: "cpu-status",
        fact_type: "metric",
      });
      engine.publishFact(f1);

      const f2 = publishableFact({
        source_ant_id: "src",
        subject_key: "cpu-status",
        fact_type: "metric",
        payload: { cpu: 95 },
      });
      engine.publishFact(f2);

      expect(engine.getFact(f1.fact_id)!.superseded_by).toBe(f2.fact_id);
      expect(engine.getFact(f1.fact_id)!.epistemic_state).toBe("superseded");
    });
  });

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  describe("Query", () => {
    it("queries by fact_type", () => {
      engine.publishFact(publishableFact({ fact_type: "a" }));
      engine.publishFact(publishableFact({ fact_type: "b" }));
      engine.publishFact(publishableFact({ fact_type: "a" }));

      expect(engine.queryFacts({ fact_type: "a" })).toHaveLength(2);
      expect(engine.queryFacts({ fact_type: "b" })).toHaveLength(1);
    });

    it("queries by state", () => {
      const f = publishableFact();
      engine.publishFact(f);
      engine.claimFact(f.fact_id, "w");
      engine.publishFact(publishableFact());

      expect(engine.queryFacts({ state: "claimed" })).toHaveLength(1);
    });

    it("getCausationChain returns ancestor chain", () => {
      const parent = publishableFact({ fact_type: "parent" });
      engine.publishFact(parent);
      engine.claimFact(parent.fact_id, "w");
      engine.resolveFact(parent.fact_id, "w", [
        { fact_type: "child", payload: { x: 1 } },
      ]);

      const children = engine.queryFacts({ fact_type: "child" });
      expect(children).toHaveLength(1);

      const chain = engine.getCausationChain(children[0].fact_id);
      expect(chain).toHaveLength(2); // parent + child
      expect(chain[0].fact_id).toBe(parent.fact_id);
    });
  });

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  describe("Stats", () => {
    it("returns comprehensive stats", () => {
      engine.publishFact(publishableFact());
      const stats = engine.getStats() as any;
      expect(stats.facts.total).toBe(1);
      expect(stats.protocol_version).toBe(PROTOCOL_VERSION);
      expect(stats.store).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Admin
  // -----------------------------------------------------------------------

  describe("Admin", () => {
    it("runs GC", () => {
      const f = publishableFact();
      engine.publishFact(f);
      engine.claimFact(f.fact_id, "w");
      engine.resolveFact(f.fact_id, "w");

      // Won't GC because retention period hasn't passed
      const result = engine.adminRunGc();
      expect(result.removed).toBe(0);
    });

    it("compacts store", () => {
      engine.publishFact(publishableFact());
      const result = engine.adminCompactStore();
      expect(result.stale_entries_removed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Recovery
  // -----------------------------------------------------------------------

  describe("Recovery", () => {
    it("recovers facts from JSONL on restart", () => {
      const fact = publishableFact();
      engine.publishFact(fact);
      engine.shutdown();

      // New engine reads the same data dir
      const engine2 = makeEngine();
      const recovered = engine2.getFact(fact.fact_id);
      expect(recovered).toBeDefined();
      expect(recovered!.fact_type).toBe("test.event");
      expect(recovered!.state).toBe("published");
      engine2.shutdown();
    });

    it("recovers claimed state", () => {
      const fact = publishableFact();
      engine.publishFact(fact);
      engine.claimFact(fact.fact_id, "w1");
      engine.shutdown();

      const engine2 = makeEngine();
      const recovered = engine2.getFact(fact.fact_id);
      expect(recovered!.state).toBe("claimed");
      expect(recovered!.claimed_by).toBe("w1");
      engine2.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // Activity log
  // -----------------------------------------------------------------------

  describe("Activity log", () => {
    it("records ant activity", () => {
      engine.connectAnt("ant-1", createAntIdentity(), () => {});
      const activity = engine.getAntActivity("ant-1");
      expect(activity.length).toBeGreaterThanOrEqual(1);
      expect(activity[0].action).toBe("connect");
    });
  });
});
