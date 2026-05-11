/**
 * Hono HTTP/WS server for antlegion-bus.
 * Mirrors Python: server/app.py
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { BusEngine } from "../engine/BusEngine.js";
import {
  createFact,
  createAntIdentity,
  createAcceptanceFilter,
  generateAntId,
  getParentFactId,
} from "../types/protocol.js";
import type {
  BusConfig,
  BusEvent,
  Fact,
  FactState,
  SemanticKind,
  FactMode,
  AcceptanceFilter,
  AntIdentity,
} from "../types/protocol.js";

export function createApp(config?: Partial<BusConfig>) {
  const engine = new BusEngine(config);
  const app = new Hono();

  app.use("*", cors());

  // =========================================================================
  // Health & Status
  // =========================================================================

  app.get("/health", (c) =>
    c.json({ status: "ok", timestamp: Date.now() / 1000 }),
  );

  app.get("/stats", (c) => c.json(engine.getStats()));

  // =========================================================================
  // Facts API
  // =========================================================================

  app.post("/facts", async (c) => {
    const body = await c.req.json();

    const authErr = verifyToken(c, engine, body.source_ant_id, body.token);
    if (authErr) return authErr;

    let causationChain: string[] = body.causation_chain ?? [];
    let causationDepth: number = body.causation_depth ?? 0;

    if (body.parent_fact_id) {
      const parent = engine.getFact(body.parent_fact_id);
      if (parent) {
        causationChain = [...parent.causation_chain, body.parent_fact_id];
        causationDepth = parent.causation_depth + 1;
      }
    }

    const fact = createFact({
      fact_type: body.fact_type,
      semantic_kind: body.semantic_kind ?? "observation",
      payload: body.payload ?? {},
      domain_tags: body.domain_tags ?? [],
      need_capabilities: body.need_capabilities ?? [],
      priority: body.priority ?? 3,
      mode: body.mode ?? "exclusive",
      source_ant_id: body.source_ant_id,
      created_at: body.created_at ?? Date.now() / 1000,
      ttl_seconds: body.ttl_seconds ?? 86400,
      schema_version: body.schema_version ?? "1.0.0",
      confidence: body.confidence ?? null,
      causation_chain: causationChain,
      causation_depth: causationDepth,
      subject_key: body.subject_key ?? "",
      supersedes: body.supersedes ?? "",
      content_hash: body.content_hash ?? "",
    });

    const [ok, reason, factId] = engine.publishFact(fact);
    if (!ok) return c.json({ error: reason }, 422);
    return c.json(factToResponse(fact), 201);
  });

  app.get("/facts", (c) => {
    const factType = c.req.query("fact_type");
    const state = c.req.query("state") as FactState | undefined;
    const sourceAntId = c.req.query("source_ant_id");
    const limit = parseInt(c.req.query("limit") ?? "100", 10);
    const sinceSequence = c.req.query("since_sequence");
    const sinceSeq = sinceSequence ? parseInt(sinceSequence, 10) : undefined;

    let facts = engine.queryFacts({
      fact_type: factType,
      state,
      source_ant_id: sourceAntId,
      limit: sinceSeq != null ? 10_000 : limit,
    });

    if (sinceSeq != null) {
      facts = facts
        .filter((f) => f.sequence_number > sinceSeq)
        .sort((a, b) => a.sequence_number - b.sequence_number)
        .slice(0, limit);
    }

    const maxSeq = facts.reduce((m, f) => Math.max(m, f.sequence_number), sinceSeq ?? 0);
    c.header("X-Antlegion-Max-Sequence", String(maxSeq));
    return c.json(facts.map(factToResponse));
  });

  app.get("/facts/cursor", (c) => {
    const stats = engine.getStats() as { facts: { total: number } };
    const all = engine.queryFacts({ limit: 1 });
    const head = all.length > 0 ? all[0].sequence_number : 0;
    return c.json({ head_sequence: head, total: stats.facts.total });
  });

  app.get("/facts/:factId", (c) => {
    const fact = engine.getFact(c.req.param("factId"));
    if (!fact) return c.json({ error: "fact not found" }, 404);
    return c.json(factToResponse(fact));
  });

  app.get("/facts/:factId/causation", (c) => {
    const chain = engine.getCausationChain(c.req.param("factId"));
    if (chain.length === 0) return c.json({ error: "fact not found" }, 404);
    return c.json(chain.map(factToResponse));
  });

  app.post("/facts/:factId/claim", async (c) => {
    const body = await c.req.json();
    const authErr = verifyToken(c, engine, body.ant_id, body.token);
    if (authErr) return authErr;

    const [ok, reason] = engine.claimFact(c.req.param("factId"), body.ant_id);
    if (!ok) return c.json({ error: reason }, 409);
    return c.json({
      success: true,
      fact_id: c.req.param("factId"),
      claimed_by: body.ant_id,
    });
  });

  app.post("/facts/:factId/resolve", async (c) => {
    const body = await c.req.json();
    const authErr = verifyToken(c, engine, body.ant_id, body.token);
    if (authErr) return authErr;

    const resultFacts = (body.result_facts ?? []).map(
      (rf: Record<string, unknown>) => ({
        fact_type: rf.fact_type ?? "",
        semantic_kind: rf.semantic_kind ?? "resolution",
        payload: rf.payload ?? {},
        domain_tags: rf.domain_tags,
        need_capabilities: rf.need_capabilities,
        priority: rf.priority,
        mode: rf.mode ?? "exclusive",
      }),
    );

    const [ok, reason] = engine.resolveFact(
      c.req.param("factId"),
      body.ant_id,
      resultFacts.length > 0 ? resultFacts : undefined,
    );
    if (!ok) return c.json({ error: reason }, 409);
    return c.json({ success: true, fact_id: c.req.param("factId") });
  });

  app.post("/facts/:factId/corroborate", async (c) => {
    const body = await c.req.json();
    const authErr = verifyToken(c, engine, body.ant_id, body.token);
    if (authErr) return authErr;

    const [ok, detail] = engine.corroborateFact(
      c.req.param("factId"),
      body.ant_id,
    );
    if (!ok) {
      const status = detail === "fact not found" ? 404 : 409;
      return c.json({ error: detail }, status);
    }
    return c.json({
      success: true,
      fact_id: c.req.param("factId"),
      epistemic_state: detail,
    });
  });

  app.post("/facts/:factId/contradict", async (c) => {
    const body = await c.req.json();
    const authErr = verifyToken(c, engine, body.ant_id, body.token);
    if (authErr) return authErr;

    const [ok, detail] = engine.contradictFact(
      c.req.param("factId"),
      body.ant_id,
    );
    if (!ok) {
      const status = detail === "fact not found" ? 404 : 409;
      return c.json({ error: detail }, status);
    }
    return c.json({
      success: true,
      fact_id: c.req.param("factId"),
      epistemic_state: detail,
    });
  });

  app.post("/facts/:factId/release", async (c) => {
    const body = await c.req.json();
    const authErr = verifyToken(c, engine, body.ant_id, body.token);
    if (authErr) return authErr;

    const [ok, reason] = engine.releaseFact(
      c.req.param("factId"),
      body.ant_id,
    );
    if (!ok) return c.json({ error: reason }, 409);
    return c.json({ success: true, fact_id: c.req.param("factId") });
  });

  // =========================================================================
  // Ants API
  // =========================================================================

  app.post("/ants/connect", async (c) => {
    const body = await c.req.json();
    const antId = generateAntId();

    const identity = createAntIdentity({
      ant_id: antId,
      name: body.name,
      description: body.description ?? "",
      acceptance_filter: createAcceptanceFilter({
        capability_offer: body.capability_offer ?? [],
        domain_interests: body.domain_interests ?? [],
        fact_type_patterns: body.fact_type_patterns ?? [],
        priority_range: body.priority_range ?? [0, 7],
        modes: body.modes ?? ["exclusive", "broadcast"],
        semantic_kinds: body.semantic_kinds ?? [],
        min_epistemic_rank: body.min_epistemic_rank ?? -3,
        min_confidence: body.min_confidence ?? 0.0,
        exclude_superseded: body.exclude_superseded ?? true,
        subject_key_patterns: body.subject_key_patterns ?? [],
      }),
      max_concurrent_claims: body.max_concurrent_claims ?? 1,
    });

    // Dummy callback — real WS callback set via /ws
    engine.connectAnt(antId, identity, () => {});
    const token = engine.generateAntToken(antId);

    return c.json({
      ant_id: antId,
      name: identity.name,
      state: identity.state,
      reliability_score: identity.reliability_score,
      token,
    });
  });

  app.post("/ants/:antId/heartbeat", async (c) => {
    const antId = c.req.param("antId");
    const body = await c.req.json().catch(() => ({}));
    const state = engine.heartbeat(antId, {
      current_action: body.current_action,
      status_text: body.status_text,
    });
    return c.json({
      ant_id: antId,
      state,
      timestamp: Date.now() / 1000,
    });
  });

  app.post("/ants/:antId/disconnect", async (c) => {
    const antId = c.req.param("antId");
    const body = await c.req.json();
    const authErr = verifyToken(c, engine, antId, body.token);
    if (authErr) return authErr;

    if (!engine.getAnt(antId)) {
      return c.json({ error: "ant not found" }, 404);
    }
    engine.disconnectAnt(antId);
    return c.json({ success: true, ant_id: antId });
  });

  app.get("/ants", (c) => {
    const includeObservers = c.req.query("include_observers") === "true";
    // UI WebSocket observers have names like "dashboard", "kanban", "ws-client"
    const UI_OBSERVER_NAMES = new Set(["dashboard", "kanban", "ws-client", "event-stream"]);
    const ants = engine.getAnts().filter(
      (cl) => includeObservers || !UI_OBSERVER_NAMES.has(cl.name)
    );
    return c.json(
      ants.map((cl) => ({
        ant_id: cl.ant_id,
        name: cl.name,
        description: cl.description,
        state: cl.state,
        reliability_score: cl.reliability_score,
        capabilities: cl.acceptance_filter.capability_offer,
        acceptance_filter: cl.acceptance_filter,
        max_concurrent_claims: cl.max_concurrent_claims,
        transmit_error_counter: cl.transmit_error_counter,
        connected_at: cl.connected_at,
        last_heartbeat: cl.last_heartbeat,
        current_action: cl.current_action,
        status_text: cl.status_text,
      })),
    );
  });

  app.get("/ants/:antId", (c) => {
    const ant = engine.getAnt(c.req.param("antId"));
    if (!ant) return c.json({ error: "ant not found" }, 404);
    return c.json({
      ant_id: ant.ant_id,
      name: ant.name,
      description: ant.description,
      state: ant.state,
      reliability_score: ant.reliability_score,
      capabilities: ant.acceptance_filter.capability_offer,
      acceptance_filter: ant.acceptance_filter,
      max_concurrent_claims: ant.max_concurrent_claims,
      transmit_error_counter: ant.transmit_error_counter,
      connected_at: ant.connected_at,
      last_heartbeat: ant.last_heartbeat,
      current_action: ant.current_action,
      status_text: ant.status_text,
    });
  });

  app.get("/ants/:antId/activity", (c) => {
    const antId = c.req.param("antId");
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    return c.json({
      ant_id: antId,
      activity: engine.getAntActivity(antId, limit),
    });
  });

  // =========================================================================
  // Admin API
  // =========================================================================

  // --- Storage ---
  app.post("/admin/storage/gc", (c) => c.json(engine.adminRunGc()));
  app.post("/admin/storage/compact", (c) => c.json(engine.adminCompactStore()));
  app.get("/admin/storage/stats", (c) => c.json(engine.getStorageStats()));

  // --- Facts management ---
  app.delete("/admin/facts/:factId", (c) => {
    const [ok, msg] = engine.adminDeleteFact(c.req.param("factId"));
    if (!ok) return c.json({ error: msg }, 404);
    return c.json({ success: true, fact_id: c.req.param("factId") });
  });

  app.post("/admin/facts/:factId/redispatch", (c) => {
    const [ok, detail] = engine.adminRedispatch(c.req.param("factId"));
    if (!ok) return c.json({ error: detail }, 404);
    return c.json({ success: true, fact_id: c.req.param("factId"), new_state: detail });
  });

  app.post("/admin/facts/batch", async (c) => {
    const body = await c.req.json();
    const factIds: string[] = body.fact_ids ?? [];
    const action: string = body.action; // "delete" | "redispatch" | "release"

    if (!factIds.length) return c.json({ error: "fact_ids required" }, 400);
    if (!["delete", "redispatch", "release"].includes(action)) {
      return c.json({ error: "action must be delete, redispatch, or release" }, 400);
    }

    const results: { fact_id: string; success: boolean; error?: string }[] = [];
    for (const fid of factIds) {
      if (action === "delete") {
        const [ok, msg] = engine.adminDeleteFact(fid);
        results.push({ fact_id: fid, success: ok, ...(!ok && { error: msg }) });
      } else if (action === "redispatch") {
        const [ok, msg] = engine.adminRedispatch(fid);
        results.push({ fact_id: fid, success: ok, ...(!ok && { error: msg }) });
      } else if (action === "release") {
        const fact = engine.getFact(fid);
        if (!fact || !fact.claimed_by) {
          results.push({ fact_id: fid, success: false, error: "not claimed" });
        } else {
          const [ok, msg] = engine.releaseFact(fid, fact.claimed_by);
          results.push({ fact_id: fid, success: ok, ...(!ok && { error: msg }) });
        }
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    return c.json({ total: factIds.length, succeeded, failed: factIds.length - succeeded, results });
  });

  app.post("/admin/facts/cleanup", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(engine.adminCleanupFacts({
      fact_states: body.fact_states,
      older_than_seconds: body.older_than_seconds,
      keep_most_recent: body.keep_most_recent ?? 0,
      dry_run: body.dry_run ?? false,
    }));
  });

  app.get("/admin/dead-letter", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "100", 10);
    return c.json(engine.getDeadLetterFacts(limit).map(factToResponse));
  });

  // --- Ants management ---
  app.post("/admin/ants/:antId/isolate", (c) => {
    const [ok, detail] = engine.adminIsolateAnt(c.req.param("antId"));
    if (!ok) return c.json({ error: detail }, 404);
    return c.json({ success: true, ant_id: c.req.param("antId"), state: detail });
  });

  app.post("/admin/ants/:antId/restore", (c) => {
    const [ok, detail] = engine.adminRestoreAnt(c.req.param("antId"));
    if (!ok) return c.json({ error: detail }, 404);
    return c.json({ success: true, ant_id: c.req.param("antId"), state: detail });
  });

  // --- Metrics ---
  app.get("/admin/metrics", (c) => c.json(engine.getMetrics()));

  // --- Causation ---
  app.get("/admin/causation/broken-chains", (c) =>
    c.json({ broken: engine.findBrokenChains() }),
  );

  app.post("/admin/causation/repair", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(engine.repairCausationChains(body.fact_id));
  });

  return { app, engine };
}

// =============================================================================
// Helpers
// =============================================================================

function verifyToken(
  c: Context,
  engine: BusEngine,
  antId: string,
  token?: string,
): Response | undefined {
  if (!token) return undefined;
  if (!engine.verifyAntToken(antId, token)) {
    return c.json({ error: `invalid token for ant ${antId}` }, 403);
  }
  return undefined;
}

function factToResponse(fact: Fact): Record<string, unknown> {
  // Map internal matched/processing to protocol-visible states
  let visibleState: string = fact.state;
  if (fact.state === "matched") visibleState = "published";
  if (fact.state === "processing") visibleState = "claimed";

  return {
    fact_id: fact.fact_id,
    fact_type: fact.fact_type,
    semantic_kind: fact.semantic_kind,
    payload: fact.payload,
    domain_tags: fact.domain_tags,
    need_capabilities: fact.need_capabilities,
    priority: fact.priority,
    mode: fact.mode,
    source_ant_id: fact.source_ant_id,
    state: visibleState,
    epistemic_state: fact.epistemic_state,
    created_at: fact.created_at,
    ttl_seconds: fact.ttl_seconds,
    claimed_by: fact.claimed_by,
    effective_priority: fact.effective_priority,
    causation_depth: fact.causation_depth,
    causation_chain: fact.causation_chain,
    parent_fact_id: getParentFactId(fact),
    confidence: fact.confidence,
    subject_key: fact.subject_key,
    supersedes: fact.supersedes,
    superseded_by: fact.superseded_by,
    content_hash: fact.content_hash,
    schema_version: fact.schema_version,
    signature: fact.signature,
    sequence_number: fact.sequence_number,
    resolved_at: fact.resolved_at,
    corroborations: fact.corroborations,
    contradictions: fact.contradictions,
    protocol_version: fact.protocol_version,
  };
}
