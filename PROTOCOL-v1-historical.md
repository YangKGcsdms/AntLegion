🌐 **English** · [简体中文说明](PROTOCOL-v1-historical.zh-CN.md)

# AntLegion Bus Protocol — v1.0 (HISTORICAL / SUPERSEDED)

> ⚠️ **This document is archived.** It is preserved for provenance and for
> readers who need to understand the v1 wire format. The live protocol has been
> re-derived from first principles ("everything is a fact in a totally-ordered
> append-only log") and now lives in [`PROTOCOL.md`](PROTOCOL.md) as **v2.0**.
>
> v1 grew a wide surface — ~30 fields per fact, two server-side state machines,
> five extensions — much of which the reference implementation never actually
> ran (priority aging, advanced arbitration, schema governance, the per-ant
> event push). v2 keeps the *ideas that earned their place* (immutability,
> content addressing, causation, contestable trust, the sequence cursor) and
> demotes the rest to **facts-about-facts folded by the reader**, shrinking the
> trusted server to "assign order, verify, persist, serve a range." See
> [`PROTOCOL.md`](PROTOCOL.md) §0 for the derivation and the v1→v2 mapping.

> Single-source protocol reference. The wire format every conforming bus
> implementation MUST honor.
>
> Designed by **Carter.Yang**. Protocol version: **1.0**.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY**, and
**OPTIONAL** are interpreted per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Axioms

These are non-negotiable. Removing any one produces a fundamentally different
system.

1. **Facts, not commands.** The bus carries statements about reality, never
   directives. `"file auth.py modified"` is a fact; `"ant-B, review auth.py"`
   is a command and is forbidden.
2. **Facts are immutable.** A published fact's content cannot be modified.
   Only the bus's assessment of it (workflow state, epistemic state) evolves.
   New facts may supersede old facts; old facts never mutate.
3. **Broadcast medium, local filtering.** All facts exist in a single shared
   space. The bus delivers facts to consumers whose declared filters match.
   There is no orchestrator.
4. **Facts are contestable.** Any consumer may corroborate or contradict any
   other consumer's fact. The bus records evidence; it does not adjudicate
   truth.
5. **Causal chains are the organizational structure.** Facts reference their
   parents. Workflow emerges from causation, not from a central planner.
6. **Fail-safe degradation.** Misbehaving consumers are progressively
   isolated. No single consumer failure can crash the bus.

---

## 2. Topology

```
┌────────────────────────────────────────────────────────────┐
│   AntLegion Bus  (one per cluster)                          │
│   - stores facts                                            │
│   - enforces protocol invariants                            │
│   - dispatches events                                       │
│   - arbitrates exclusive claims                             │
└──────────────────────────┬─────────────────────────────────┘
                           │  HTTP / JSON
                           │  (this protocol)
                           │
              ┌────────────┴────────────┐
              │      MCP adapter         │  ◀── canonical client interface
              │  (antlegion-mcp/)        │      (6 tools, hides protocol detail)
              └────────────┬────────────┘
                           │
       ┌──────┬──────┬─────┴─────┬──────┬──────┐
       ▼      ▼      ▼           ▼      ▼      ▼
   Claude  Cursor  Cline    Continue Codex  Goose  …
    Code                              CLI
```

**Bus** — the shared communication medium. Exactly one per cluster.

**MCP adapter** — the canonical client interface. Speaks MCP to clients,
HTTP to the bus, hides content hashing, signing, tokens, ant identity,
causation depth, and semantic kinds.

**Clients** — anything that speaks MCP. The protocol does not distinguish
between AI agents, human-driven IDEs, cron jobs, or CI runners. They all
poll the bus on whatever cadence they choose.

This document specifies the **bus**. The MCP adapter is documented in
[`antlegion-mcp/README.md`](antlegion-mcp/README.md). Direct HTTP clients that
bypass MCP MUST implement the same wire format described here.

---

## 3. The Fact

The atomic unit of communication.

A Fact has two structural zones:

- **Immutable Record** — set by the publisher, frozen after publish, covered
  by `content_hash`.
- **Mutable Bus State** — managed exclusively by the bus, changes as the fact
  moves through its lifecycle.

### 3.1 Immutable Record

| Field | Type | Req. | Description |
|---|---|---|---|
| `fact_id` | string | MUST | Globally unique identifier |
| `fact_type` | string | MUST | Dot-notation taxonomy, e.g. `code.review.needed` |
| `payload` | object | MUST | Fact data. Schema determined by `fact_type` |
| `source_ant_id` | string | MUST | Publisher's identifier |
| `created_at` | float | MUST | Unix timestamp (seconds) |
| `mode` | enum | MUST | `exclusive` (one handler) or `broadcast` (all matching) |
| `priority` | int 0–7 | MUST | Lower = higher priority (CAN convention); see §6 |
| `ttl_seconds` | int | MUST | Time to live. After expiry → `dead` |
| `parent_fact_id` | string | OPTIONAL | Direct causal parent. Empty for root facts |
| `causation_chain` | string[] | OPTIONAL | Full ancestor path. Last element MUST match `parent_fact_id` if both present |
| `causation_depth` | int | MUST | 0 for root facts. Bus MUST enforce a maximum |
| `confidence` | float 0–1 | OPTIONAL | Publisher's self-assessed certainty. Absent ≠ certain |
| `domain_tags` | string[] | OPTIONAL | Content domain tags, e.g. `["python", "auth"]` |
| `need_capabilities` | string[] | OPTIONAL | Capabilities needed to handle this fact |
| `semantic_kind` | enum | OPTIONAL | `observation` / `assertion` / `request` / `resolution` / `correction` / `signal` |
| `subject_key` | string | OPTIONAL | Groups facts about the same entity for auto-supersession |
| `supersedes` | string | OPTIONAL | Explicit `fact_id` this fact replaces |
| `content_hash` | string | MUST | SHA-256 of canonical record (§10) |

### 3.2 Mutable Bus State

| Field | Type | Description |
|---|---|---|
| `state` | enum | Workflow state (§4.1) |
| `epistemic_state` | enum | Trust state (§4.2) |
| `claimed_by` | string \| null | Consumer that claimed (exclusive only) |
| `claimed_at` | float \| null | Claim timestamp; used for claim-timeout reaping (§4.1) |
| `resolved_at` | float \| null | Resolution timestamp |
| `superseded_by` | string | Set when a newer fact supersedes this one |
| `corroborations` | string[] | Consumers that have corroborated |
| `contradictions` | string[] | Consumers that have contradicted |
| `sequence_number` | int | Monotonic, assigned at acceptance. Used as polling cursor |
| `signature` | string | HMAC over `(fact_id, content_hash, source_ant_id, fact_type, created_at)` |

Implementations MAY track additional internal state (`effective_priority`,
TEC counters, …) but it MUST NOT appear in protocol-visible responses.

---

## 4. State Machines

Each fact carries **two orthogonal** state machines.

### 4.1 Workflow State

Tracks lifecycle. Explicit transitions driven by bus operations.

```
            PUBLISH
  ─────────────────────▶ published ─────┐
                              │         │
                    exclusive │         │ broadcast
                              ▼         │
                          claimed       │
                              │         │
                              ▼         ▼
                          resolved   resolved
                              │
                              └──▶ may emit child facts

  Any non-terminal state ──▶ dead   (TTL expiry, all releases, failure)
```

| State | Description |
|---|---|
| `published` | Accepted by the bus, visible to matching consumers |
| `claimed` | One consumer has exclusive responsibility (exclusive mode only) |
| `resolved` | Processing complete. May have produced child facts |
| `dead` | Could not be processed (TTL expired, no claim, explicit failure) |

| Transition | Trigger |
|---|---|
| — → `published` | PUBLISH accepted |
| `published` → `claimed` | CLAIM (exclusive only) |
| `published` → `resolved` | Direct resolution (broadcast only) |
| `published` → `dead` | TTL expiry, no match |
| `claimed` → `resolved` | RESOLVE by claimer |
| `claimed` → `published` | RELEASE by claimer, **or claim timeout** (returns to pool, re-dispatched) |
| `claimed` → `dead` | Hard failure (not used by the current implementation; reserved) |

**Claim timeout** — if a fact has been in `claimed` longer than the bus's
configured `claimTimeoutSeconds` (default 600s = 10 min, §11), the bus
auto-releases it back to `published` and re-dispatches it. This is the
recovery path when a claimer crashes between CLAIM and RESOLVE. The bus
excludes the previous claimer from the next dispatch round to prevent a
crash-loop pinning the same fact.
| `dead` → `published` | Administrative redispatch (OPTIONAL) |

### 4.2 Epistemic State

Tracks trust. **Derived** from accumulated evidence — not driven by explicit
transitions. Implementations MUST recompute after every corroborate /
contradict / supersede.

```
                  corroborations ≥ quorum
   asserted ─corroborate──▶ corroborated ─more─▶ consensus
       │
       │── contradict
       ▼
   contested ─contradictions ≥ quorum──▶ refuted

   superseded_by set  ──▶ superseded  (overrides everything)
```

Recomputation rule (evaluated in order):

1. `superseded_by` set → `superseded`
2. `|contradictions| ≥ refute_quorum` → `refuted`
3. `contradictions` non-empty → `contested`
4. `|corroborations| ≥ consensus_quorum` → `consensus`
5. `corroborations` non-empty → `corroborated`
6. otherwise → `asserted`

Quorum defaults: `consensus_quorum = refute_quorum = 2`.

**Rank for filter comparison:**

| State | Rank |
|---|:---:|
| `superseded` | -3 |
| `refuted` | -2 |
| `contested` | -1 |
| `asserted` | 0 |
| `corroborated` | +1 |
| `consensus` | +2 |

`superseded` lives in the same enum as the trust values because **freshness
takes precedence over confidence**. A once-consensus fact that has been
superseded is stale knowledge in every filter decision.

### 4.3 Supersession

Two paths.

1. **Explicit**: `fact.supersedes = old_fact_id`. Bus marks the target
   superseded.
2. **Automatic**: `fact.subject_key` is set and another non-terminal fact
   shares the same `(subject_key, fact_type)`. Bus marks the older one
   superseded.

Auto-supersession is appropriate for *latest-wins* fact types (sensor
readings, deployment status). It is **inappropriate** for accumulating
diagnostics, multi-source observations, or parallel analyses. To gate
auto-supersession, implementations SHOULD require either:

- the fact_type's registered schema declares `auto_supersede: true`, or
- `semantic_kind ∈ {observation, signal, correction}`.

Publishers can opt out per-fact by omitting `subject_key` and using explicit
`supersedes` instead.

---

## 5. Acceptance Filter

A consumer's declaration of what facts it wants. Content-based.

| Dimension | Type | Description |
|---|---|---|
| `capability_offer` | string[] | What this consumer can do |
| `domain_interests` | string[] | What domains it subscribes to |
| `fact_type_patterns` | string[] | Glob patterns, e.g. `code.*`, `deploy.*.completed` |
| `priority_range` | [int, int] | Accepted priority range (low, high) |
| `modes` | enum[] | `["broadcast"]`, `["exclusive"]`, or both |
| `semantic_kinds` | enum[] | Empty = accept all |
| `min_epistemic_rank` | int | Minimum trust level (default -3 = accept all) |
| `min_confidence` | float | Minimum publisher confidence (default 0.0) |
| `exclude_superseded` | bool | Default true |

A fact reaches a consumer iff ALL pass:

1. Consumer state ∈ {active, degraded} (not isolated/offline)
2. `fact.priority ∈ filter.priority_range`
3. `fact.mode ∈ filter.modes`
4. If `filter.semantic_kinds` non-empty: `fact.semantic_kind ∈ filter.semantic_kinds`
5. `epistemic_rank(fact) ≥ filter.min_epistemic_rank`
6. `fact.confidence ≥ filter.min_confidence` (if set)
7. If `filter.exclude_superseded`: `fact.epistemic_state ≠ superseded`
8. **Content match** — at least one of:
   - `fact.need_capabilities ∩ filter.capability_offer ≠ ∅`
   - `fact.domain_tags ∩ filter.domain_interests ≠ ∅`
   - `fact.fact_type` matches any `filter.fact_type_patterns` (glob)
   - All three lists are empty (monitor mode)

---

## 6. Priority

3-bit field (0–7), CAN convention (lower = higher).

| Value | Name | Description |
|:---:|---|---|
| 0 | CRITICAL | System failures, data-loss prevention |
| 1 | HIGH | User-facing blocking issues |
| 2 | ELEVATED | Important but not blocking |
| 3 | NORMAL | Default |
| 4 | LOW | Background work |
| 5 | BACKGROUND | Housekeeping, optimization |
| 6 | IDLE | Best-effort |
| 7 | BULK | Batch processing |

Buses SHOULD implement aging so low-priority facts are not starved. Facts
MUST NOT age into CRITICAL — that level is reserved for genuine emergencies.

---

## 7. Bus Operations (Wire Format)

All operations are HTTP/1.1 + JSON. There is no event push channel; clients
poll with `since_sequence` (§7.3).

### 7.1 Connect

```
POST /ants/connect
{ "name": "...", "description": "...",
  "capability_offer": [], "domain_interests": [], "fact_type_patterns": ["*"],
  "modes": ["broadcast", "exclusive"], "max_concurrent_claims": 1 }
→ { "ant_id": "...", "token": "...", "state": "active" }
```

The token is required for CLAIM / RESOLVE / RELEASE. PUBLISH MAY be performed
without a token (anonymous publish; bus skips reliability tracking).

### 7.2 Publish

```
POST /facts
{ "fact_type": "...", "payload": {...},
  "source_ant_id": "...", "token": "...",      // token optional
  "content_hash": "...",                       // empty string → bus computes
  "created_at": <unix-seconds>,
  "mode": "broadcast" | "exclusive",           // default: broadcast
  "priority": 0..7, "ttl_seconds": <int>,
  "parent_fact_id": "...", "subject_key": "...", "supersedes": "...",
  "semantic_kind": "...", "confidence": 0..1,
  "domain_tags": [], "need_capabilities": [] }
→ 201 Created with the full fact object (bus-assigned fields populated)
```

Admission checks run in this order (cheapest first):

1. Content hash verification (MUST)
2. Causation depth limit (MUST)
3. Causation cycle detection (SHOULD)
4. Deduplication window on `(source_ant_id, fact_type, content_hash)` (SHOULD)
5. Per-source rate limit (SHOULD)
6. Global load breaker (MAY)
7. Reliability gate (MAY, requires Fault Confinement, §9.2)
8. Schema validation (MAY, requires Schema Governance, §9.4)

Any check failing rejects the publish.

### 7.3 Query (the polling cursor)

```
GET /facts?fact_type=...&state=...&claimed_by=...&source_ant_id=...&since_sequence=N&limit=50
→ JSON array, sorted by sequence_number ascending when since_sequence is set
   Response header: X-Antlegion-Max-Sequence: <max sequence returned>
```

Clients drive their own polling loop by passing the previous response's max
sequence back as `since_sequence`. This is the canonical pattern.

`fact_type` accepts a **glob** pattern (`*` matches any substring, `?` matches
one character). `bug.*` matches `bug.found`, `bug.fixed`, etc. A pattern with
no glob characters is matched exactly.

`claimed_by` filters facts currently held by a specific consumer. Useful for
a daemon that wants to find its own orphaned claims on restart:
`GET /facts?state=claimed&claimed_by=my-daemon-1`.

```
GET /facts/cursor
→ { "head_sequence": <int>, "total": <int> }
```

Useful for starting a new client at "newest only" (initial `cursor = head_sequence`).

### 7.4 Claim / Resolve / Release

```
POST /facts/:fact_id/claim
{ "ant_id": "...", "token": "..." }
→ 200 { "success": true }   |   409 { "error": "already claimed by ..." }

POST /facts/:fact_id/resolve
{ "ant_id": "...", "token": "...",
  "result_facts": [{ "fact_type": "...", "payload": {...}, "mode": "..." }] }
→ 200 { "success": true }

POST /facts/:fact_id/release
{ "ant_id": "...", "token": "..." }
→ 200 { "success": true }
```

CLAIM is atomic. If two consumers attempt CLAIM concurrently, exactly one
succeeds. The bus MUST reject RESOLVE / RELEASE from anyone other than the
current claimer.

`result_facts` are published as children: each inherits
`causation_chain = parent.chain + [parent.id]` and `causation_depth = parent.depth + 1`.

### 7.5 Corroborate / Contradict

```
POST /facts/:fact_id/corroborate     { "ant_id": "...", "token": "..." }
POST /facts/:fact_id/contradict      { "ant_id": "...", "token": "..." }
→ 200 { "success": true, "epistemic_state": "..." }
```

A consumer MUST NOT corroborate or contradict its own facts; the bus MUST
reject such attempts.

### 7.6 Causation walk

```
GET /facts/:fact_id/causation
→ JSON array, root → fact (the fact itself is the last entry)
```

### 7.7 Heartbeat / Disconnect

```
POST /ants/:ant_id/heartbeat        { "current_action": "...", "status_text": "..." }
POST /ants/:ant_id/disconnect       { "token": "..." }
```

Heartbeats are used by Fault Confinement (§9.2) to track liveness.
Disconnects are graceful.

### 7.8 Operator surface (non-normative)

For operators running the bus itself:

```
POST /admin/storage/gc          → run GC sweep now, return { removed, fact_ids }
POST /admin/storage/compact     → compact the JSONL log, return { stale_entries_removed }
GET  /admin/storage/stats       → JSONL log stats + fact count
GET  /admin/metrics             → stats + derived rates (resolution_rate, dead_letter_rate, …)
```

These four are the entire admin surface. Per-fact remediation (delete /
redispatch / dead-letter listing) and per-ant remediation (isolate / restore)
were intentionally removed: they accumulated complexity without a stated
user. Operators who need them can write a thin admin client against the
public APIs.

---

## 8. Events (non-normative)

This protocol is **poll-only**. Clients drive their own scan loop via
`GET /facts?since_sequence=N` (§7.3). The bus has no push channel.

An earlier draft included a WebSocket per-ant event push (`fact_available` /
`fact_claimed` / `fact_resolved` / `fact_dead` / `fact_trust_changed` /
`fact_superseded` / `ant_state_changed`). It was removed because the
canonical client interface (MCP, §2) cannot make use of it: MCP transports
are request/response over stdio. Implementations MAY add their own out-of-tree
event channel for legacy clients, but it is not part of this protocol and
conforming implementations need not provide it.

---

## 9. Optional Extensions

The core protocol covers Sections 3–7. Extensions add bounded, well-defined
capability on top.

### 9.1 Epistemic States — *Stable*

Adds the `epistemic_state` field, the recomputation rule (§4.2), and the
`fact_trust_changed` event. When refuted/contested, the bus SHOULD include
`parent_fact_id` in the event so consumers can trace affected chains.

The bus MUST NOT cascade epistemic state changes to descendants —
that would violate the non-adjudication axiom. Consumers performing causal
chain queries SHOULD check ancestor states themselves.

### 9.2 Fault Confinement — *Stable*

Per-consumer error counters (CAN-style).

| Field on consumer | Description |
|---|---|
| `transmit_error_counter` (TEC) | Incremented on errors, decremented on successes |
| `reliability_score` ∈ [0, 1] | Derived from TEC |

| TEC range | State | `reliability_score` |
|---|:---:|:---:|
| 0 – 127 | active | 1.0 |
| 128 – 255 | degraded | 0.5 |
| ≥ 256 | isolated | 0.0 |

| Event | TEC Δ |
|---|:---:|
| Fact contradicted | +8 |
| Schema validation failure | +8 |
| Fact expired unresolved | +2 |
| Rate limit exceeded | +1 |
| Fact corroborated | -1 |
| Fact resolved | -1 |
| Heartbeat OK | -1 |

TEC floor is 0. Isolated consumers cannot win exclusive arbitration. A
degraded consumer competes at half weight.

### 9.3 Advanced Arbitration — *Stable*

```
score = (capability_overlap × 10 + domain_overlap × 5 + type_pattern_hit × 3)
        × reliability_score
```

Tiebreakers: score → reliability_score → ant_id (lexicographic).

Without Advanced Arbitration, the bus uses first-arrival.

### 9.4 Schema Governance — *Experimental*

A schema registry per `fact_type`. Modes: `OPEN` (no validation),
`WARN` (log but accept), `STRICT` (reject invalid). Schema evolution
follows the usual rules:

| Change | Status |
|---|---|
| Add optional field | Backward-compatible |
| Remove required field | Breaking — bump version or new `fact_type` |
| Change field type | Breaking |

### 9.5 Storm Protection — *Stable*

Concrete parameters for the SHOULD-level admission checks in §7.2.

| Check | Recommended value |
|---|---|
| Causation depth limit | 16 |
| Cycle detection | Verify `fact_id` not in ancestor chain |
| Dedup key | `(source_ant_id, fact_type, content_hash)` |
| Dedup window | 10s |
| Per-source rate limit | Token bucket, capacity 20, refill 5/s |
| Global load breaker | 200 facts / 5s window → accept only priority ≤ 1 |
| Priority aging | Every 30s, priority -= 1, floor = 1 (never CRITICAL) |

---

## 10. Content Hash & Signing

### 10.1 Canonical record

The canonical record covers the **complete immutable record**, not just
payload. Optional fields are included **only when present** (non-null,
non-empty).

```python
canonical = {
    "fact_type":       fact.fact_type,
    "payload":         fact.payload,           # raw dict, not re-serialised
    "source_ant_id":   fact.source_ant_id,
    "created_at":      fact.created_at,
    "mode":            fact.mode,
    "priority":        fact.priority,
    "ttl_seconds":     fact.ttl_seconds,
    "causation_depth": fact.causation_depth,
}
if fact.parent_fact_id:    canonical["parent_fact_id"]    = fact.parent_fact_id
if fact.confidence is not None: canonical["confidence"]    = fact.confidence
if fact.domain_tags:       canonical["domain_tags"]       = sorted(fact.domain_tags)
if fact.need_capabilities: canonical["need_capabilities"] = sorted(fact.need_capabilities)
if fact.subject_key:       canonical["subject_key"]       = fact.subject_key
if fact.supersedes:        canonical["supersedes"]        = fact.supersedes
if fact.semantic_kind:     canonical["semantic_kind"]     = fact.semantic_kind
```

Serialization:

```python
canonical_str = json.dumps(canonical, sort_keys=True, ensure_ascii=False)
content_hash  = sha256(canonical_str.encode()).hexdigest()
```

List fields are sorted for order-independent hashing.

`fact_id` is **excluded** — it may be bus-assigned. If the client
pre-generates it, they SHOULD include it in their own integrity checks but
NOT in the cross-implementation canonical record.

If a publisher sends `content_hash`, it MUST equal the bus's computation.
Because `created_at` is part of the canonical record, clients pre-computing
the hash MUST send the same `created_at`. The simplest path is to send
`content_hash = ""` and let the bus compute it.

### 10.2 Bus signature

```
message   = f"{fact_id}|{content_hash}|{source_ant_id}|{fact_type}|{created_at}"
signature = hmac_sha256(bus_secret, message)
```

The bus signs every accepted fact. Set `ANTLEGION_BUS_SECRET` to a stable
value in production — a fresh random secret on each boot makes existing
signatures unverifiable across restarts.

---

## 11. Mandatory and Recommended Defaults

| Parameter | Default | Source |
|---|:---:|---|
| Default fact TTL | 86400s (24h) | Implementation choice; was 1800s before, raised for client polling |
| Default fact `mode` | `broadcast` | §7.2 — most LLM-published facts are observations, not tasks |
| Claim timeout | 600s (10 min) | §4.1 — claimed facts auto-released back to `published` |
| Causation depth limit | 16 | §9.5 |
| Consensus / refutation quorum | 2 | §4.2 |
| Dedup window | 10s | §9.5 |
| Per-source rate limit | 20 burst, 5/s sustained | §9.5 |
| Global load breaker | 200 facts / 5s → only priority ≤ 1 | §9.5 |
| Priority aging | -1 every 30s, floor 1 | §9.5 |
| Fault Confinement degraded threshold | TEC = 128 | §9.2 |
| Fault Confinement isolated threshold | TEC = 256 | §9.2 |
| GC retain resolved | 86400s | Bumped from 600s for polling-friendly retention |
| GC retain dead | 86400s | Bumped from 3600s |
| GC max facts in memory | 10,000 | Implementation choice |
| JSONL compaction interval | 3600s | Implementation choice |

---

## 12. Storage and Recovery

The reference implementation uses an append-only JSONL log:

- Each lifecycle event (publish / claim / resolve / release / supersede /
  corroborate / contradict / purge) is one JSON line.
- Compaction removes entries for facts no longer in memory.
- Recovery on startup replays the log to rebuild in-memory state.

### Tail corruption

A process killed mid-write may leave a partial final line. On startup:

1. Read line by line with a streaming parser.
2. Skip any line that fails JSON parsing (log a warning with byte offset).
3. Accept only lines that deserialize into a recognized event schema.
4. After recovery, truncate the file to the last successfully parsed byte
   boundary before appending new events.

Compaction MUST use a temp file + atomic rename (`os.replace`) so a partial
compaction cannot corrupt the primary log.

---

## 13. Safety Invariants the Bus MUST Enforce

| Invariant | Notes |
|---|---|
| Content integrity | Reject facts where `content_hash` mismatches |
| Causation depth limit | Reject facts exceeding the configured maximum |
| Immutability | Never modify the immutable record after publish |
| Claim exclusivity | At most one consumer holds a claim on any exclusive fact at any time |
| TTL enforcement | Expire facts past `created_at + ttl_seconds` |
| Cross-domain by derivation only | A fact's `fact_type` and other immutable fields MUST NOT be modified to change its domain; cross-domain propagation MUST publish a new derived fact with `parent_fact_id` linkage |

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **Fact** | Immutable statement about reality, the atomic coordination unit |
| **Bus** | The shared communication medium connecting all consumers |
| **Consumer / Ant** | Any process connected to the bus — AI agent, MCP adapter, gateway, monitor |
| **Acceptance Filter** | A consumer's declaration of what facts it wants to receive |
| **Causation Depth** | How many ancestor facts led to this one |
| **Parent Fact** | Direct causal predecessor |
| **Corroboration** | Another consumer confirming a fact's validity |
| **Contradiction** | Another consumer disputing a fact's validity |
| **Exclusive** | Mode where at most one consumer handles the fact |
| **Broadcast** | Mode where all matching consumers see the fact |
| **Dead** | Terminal state for a fact that could not be processed |
| **Superseded** | Replaced by a newer fact (subject_key or explicit `supersedes`) |
| **TEC** | Transmit Error Counter, per-consumer reliability metric |

---

## Appendix A: Lineage

| Source | What we take |
|---|---|
| **CAN Bus (ISO 11898)** | Content-addressed messaging, broadcast + local filtering, priority arbitration, TEC error state machine, no central master |
| **Event Sourcing** | Immutable append-only log, idempotent consumption, choreography over orchestration |
| **Scientific method** | Peer review (corroborate / contradict), confidence reporting, knowledge supersession |
| **Git** | Append-only, content-hashed, immutable history; client-driven `fetch` via sequence cursor |

---

*Protocol designed by Carter.Yang. Architecture Sovereignty Notice applies.*
