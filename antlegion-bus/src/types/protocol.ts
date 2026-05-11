/**
 * Core protocol types for Ant Legion Bus.
 *
 * These types ARE the protocol specification in machine-readable form.
 * Mirrors the Python reference implementation (ant_legion_bus/types.py).
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = "1.0.0";
export const DEFAULT_CONSENSUS_QUORUM = 2;
export const DEFAULT_REFUTATION_QUORUM = 2;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Workflow states — tracks where a fact is in its processing lifecycle. */
export type FactState =
  | "created"
  | "published"
  | "matched"
  | "claimed"
  | "processing"
  | "resolved"
  | "dead";

/** Truth states — tracks how trustworthy a fact is considered. */
export type EpistemicState =
  | "asserted"
  | "corroborated"
  | "consensus"
  | "contested"
  | "refuted"
  | "superseded";

/** Rank ordering for filter comparison: higher = more trusted. */
export const EPISTEMIC_RANK: Record<EpistemicState, number> = {
  superseded: -3,
  refuted: -2,
  contested: -1,
  asserted: 0,
  corroborated: 1,
  consensus: 2,
};

/**
 * Classifies WHAT a fact represents epistemically.
 * Keeps the Fact envelope universal while distinguishing observations
 * from requests from corrections.
 */
export type SemanticKind =
  | "observation"
  | "assertion"
  | "request"
  | "resolution"
  | "correction"
  | "signal";

/** Delivery semantics — the critical routing decision. */
export type FactMode = "broadcast" | "exclusive";

/**
 * Priority levels, lower value = higher priority (CAN convention).
 * Range 0–7 mirrors CAN's 3-bit priority field in J1939.
 */
export const Priority = {
  CRITICAL: 0,
  HIGH: 1,
  ELEVATED: 2,
  NORMAL: 3,
  LOW: 4,
  BACKGROUND: 5,
  IDLE: 6,
  BULK: 7,
} as const;

export type PriorityValue = (typeof Priority)[keyof typeof Priority];

/**
 * Node health states, modeled after CAN's error state machine:
 *   CAN: error-active → error-passive → bus-off
 *   Bus: active → degraded → isolated
 */
export type AntState = "active" | "degraded" | "isolated" | "offline";

// ---------------------------------------------------------------------------
// Fact: The atomic unit on the bus
// ---------------------------------------------------------------------------

/**
 * The fundamental unit of communication on the Legion Bus.
 *
 * Structurally divided into two zones:
 *   - IMMUTABLE RECORD: Set at creation, never modified after publish.
 *     Covered by content_hash and bus signature.
 *   - MUTABLE BUS STATE: Managed exclusively by the bus engine.
 *     Changes as the fact moves through workflow and trust lifecycles.
 */
export interface Fact {
  // ===== IMMUTABLE RECORD (frozen after publish) =====

  // --- Identity ---
  fact_id: string;
  fact_type: string;
  semantic_kind: SemanticKind;

  // --- Content ---
  payload: Record<string, unknown>;

  // --- Content Addressing ---
  domain_tags: string[];
  need_capabilities: string[];

  // --- Routing ---
  priority: number;
  mode: FactMode;

  // --- Lineage ---
  source_ant_id: string;
  causation_chain: string[];
  causation_depth: number;

  // --- Knowledge Evolution ---
  subject_key: string;
  supersedes: string;

  // --- Lifecycle ---
  created_at: number; // seconds Unix timestamp
  ttl_seconds: number;
  schema_version: string;

  // --- Trust (publisher-provided) ---
  confidence: number | null;

  // --- Integrity ---
  content_hash: string;
  signature: string;

  // --- Protocol ---
  protocol_version: string;

  // ===== MUTABLE BUS STATE (managed by engine) =====

  state: FactState;
  epistemic_state: EpistemicState;
  claimed_by: string | null;
  resolved_at: number | null;
  effective_priority: number | null;
  sequence_number: number;
  superseded_by: string;
  corroborations: string[];
  contradictions: string[];
}

/** Generate a short hex id (16 chars from UUID). */
export function generateFactId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Generate a short hex id for ant (12 chars from UUID). */
export function generateAntId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Create a new Fact with defaults. */
export function createFact(overrides: Partial<Fact> = {}): Fact {
  return {
    fact_id: generateFactId(),
    fact_type: "",
    semantic_kind: "observation",
    payload: {},
    domain_tags: [],
    need_capabilities: [],
    priority: Priority.NORMAL,
    mode: "exclusive",
    source_ant_id: "",
    causation_chain: [],
    causation_depth: 0,
    subject_key: "",
    supersedes: "",
    created_at: Date.now() / 1000,
    ttl_seconds: 86400,
    schema_version: "1.0.0",
    confidence: null,
    content_hash: "",
    signature: "",
    protocol_version: PROTOCOL_VERSION,
    state: "created",
    epistemic_state: "asserted",
    claimed_by: null,
    resolved_at: null,
    effective_priority: null,
    sequence_number: 0,
    superseded_by: "",
    corroborations: [],
    contradictions: [],
    ...overrides,
  };
}

/** Direct causal parent (last entry in causation_chain), or empty for root facts. */
export function getParentFactId(fact: Fact): string {
  return fact.causation_chain.length > 0
    ? fact.causation_chain[fact.causation_chain.length - 1]
    : "";
}

/** Check if a fact has expired based on its TTL. */
export function isExpired(fact: Fact): boolean {
  return Date.now() / 1000 > fact.created_at + fact.ttl_seconds;
}

/** Create a child fact inheriting causation lineage. */
export function deriveChild(
  parent: Fact,
  factType: string,
  payload: Record<string, unknown>,
  sourceAntId: string,
  overrides: Partial<Fact> = {},
): Fact {
  return createFact({
    fact_type: factType,
    payload,
    source_ant_id: sourceAntId,
    causation_chain: [...parent.causation_chain, parent.fact_id],
    causation_depth: parent.causation_depth + 1,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Acceptance Filter
// ---------------------------------------------------------------------------

/**
 * CAN-style acceptance filter for a ant.
 * Epistemic and semantic filtering dimensions let consumers say
 * "only give me corroborated observations about build.*".
 */
export interface AcceptanceFilter {
  capability_offer: string[];
  domain_interests: string[];
  fact_type_patterns: string[];
  priority_range: [number, number];
  modes: FactMode[];
  semantic_kinds: SemanticKind[];
  min_epistemic_rank: number;
  min_confidence: number;
  exclude_superseded: boolean;
  subject_key_patterns: string[];
}

/** Create an AcceptanceFilter with defaults (accepts everything). */
export function createAcceptanceFilter(
  overrides: Partial<AcceptanceFilter> = {},
): AcceptanceFilter {
  return {
    capability_offer: [],
    domain_interests: [],
    fact_type_patterns: [],
    priority_range: [Priority.CRITICAL, Priority.BULK],
    modes: ["exclusive", "broadcast"],
    semantic_kinds: [],
    min_epistemic_rank: -3,
    min_confidence: 0.0,
    exclude_superseded: true,
    subject_key_patterns: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ant Identity
// ---------------------------------------------------------------------------

/** An agent's presence on the bus. */
export interface AntIdentity {
  ant_id: string;
  name: string;
  description: string;
  acceptance_filter: AcceptanceFilter;
  max_concurrent_claims: number;
  state: AntState;
  transmit_error_counter: number;
  reliability_score: number;
  connected_at: number | null;
  last_heartbeat: number | null;
  current_action: string;
  status_text: string;
}

/** Create a AntIdentity with defaults. */
export function createAntIdentity(
  overrides: Partial<AntIdentity> = {},
): AntIdentity {
  return {
    ant_id: generateAntId(),
    name: "",
    description: "",
    acceptance_filter: createAcceptanceFilter(),
    max_concurrent_claims: 1,
    state: "offline",
    transmit_error_counter: 0,
    reliability_score: 1.0,
    connected_at: null,
    last_heartbeat: null,
    current_action: "",
    status_text: "",
    ...overrides,
  };
}

/** Check if a ant is in a healthy state. */
export function isAntHealthy(ant: AntIdentity): boolean {
  return ant.state === "active" || ant.state === "degraded";
}

// ---------------------------------------------------------------------------
// Bus Operations
// ---------------------------------------------------------------------------

export type OpCode =
  | "connect"
  | "disconnect"
  | "heartbeat"
  | "publish"
  | "claim"
  | "release"
  | "resolve"
  | "query"
  | "subscribe"
  | "corroborate"
  | "contradict";

// ---------------------------------------------------------------------------
// Bus Events
// ---------------------------------------------------------------------------

export type BusEventType =
  | "fact_available"
  | "fact_claimed"
  | "fact_resolved"
  | "fact_expired"
  | "fact_dead"
  | "fact_superseded"
  | "fact_trust_changed"
  | "ant_state_changed";

/** Notification pushed from bus to ant. */
export interface BusEvent {
  event_type: BusEventType;
  fact?: Fact;
  ant_id?: string;
  detail?: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// HTTP API Models
// ---------------------------------------------------------------------------

export interface FactCreateRequest {
  fact_type: string;
  payload: Record<string, unknown>;
  source_ant_id: string;
  token: string;
  content_hash: string;
  created_at: number;
  semantic_kind?: SemanticKind;
  domain_tags?: string[];
  need_capabilities?: string[];
  priority?: number;
  mode?: FactMode;
  causation_chain?: string[];
  subject_key?: string;
  supersedes?: string;
  ttl_seconds?: number;
  confidence?: number | null;
}

export interface AntConnectRequest {
  name: string;
  description?: string;
  capability_offer?: string[];
  domain_interests?: string[];
  fact_type_patterns?: string[];
  priority_range?: [number, number];
  modes?: FactMode[];
  semantic_kinds?: SemanticKind[];
  max_concurrent_claims?: number;
  min_epistemic_rank?: number;
  min_confidence?: number;
  exclude_superseded?: boolean;
  subject_key_patterns?: string[];
}

export interface AntConnectResponse {
  ant_id: string;
  name: string;
  state: AntState;
  reliability_score: number;
  token: string;
}

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export type SchemaEnforcement = "open" | "warn" | "strict";

export type SchemaFieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "enum";

export interface SchemaField {
  name: string;
  type: SchemaFieldType;
  required: boolean;
  description: string;
  default: unknown;
  enum_values: string[] | null;
  array_item_type: SchemaFieldType | null;
}

export interface FactSchema {
  fact_type: string;
  version: string;
  description: string;
  fields: SchemaField[];
  required_payload_fields: string[];
}

// ---------------------------------------------------------------------------
// JSONL persistence event types
// ---------------------------------------------------------------------------

export type JournalEventType =
  | "publish"
  | "claim"
  | "release"
  | "resolve"
  | "dead"
  | "redispatch"
  | "corroborate"
  | "contradict"
  | "supersede"
  | "causation_repair"
  | "purge";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BusConfig {
  server: {
    port: number;
    host: string;
  };
  data: {
    dir: string;
  };
  bus: {
    maxCausationDepth: number;
    defaultTtlSeconds: number;
    gcRetainResolvedSeconds: number;
    gcRetainDeadSeconds: number;
    gcMaxFacts: number;
    replayOnReconnect: number;
  };
  flow: {
    dedupeWindowSeconds: number;
    rateLimitCapacity: number;
    rateLimitRefillRate: number;
    circuitBreakerWindowSeconds: number;
    circuitBreakerThreshold: number;
  };
  trust: {
    consensusQuorum: number;
    refutationQuorum: number;
  };
}

export const DEFAULT_CONFIG: BusConfig = {
  server: {
    port: 28080,
    host: "0.0.0.0",
  },
  data: {
    dir: ".data",
  },
  bus: {
    maxCausationDepth: 16,
    defaultTtlSeconds: 86400,
    gcRetainResolvedSeconds: 86400,
    gcRetainDeadSeconds: 86400,
    gcMaxFacts: 10000,
    replayOnReconnect: 50,
  },
  flow: {
    dedupeWindowSeconds: 10,
    rateLimitCapacity: 20,
    rateLimitRefillRate: 5,
    circuitBreakerWindowSeconds: 5,
    circuitBreakerThreshold: 200,
  },
  trust: {
    consensusQuorum: 2,
    refutationQuorum: 2,
  },
};
