# Architecture

Two services, one protocol. Clients are anything that speaks MCP.

```
┌──────────────────────────────────────────────────────────────────┐
│                      AntLegion Bus                               │
│  (antlegion-bus/, Hono + JSONL append-only store)                │
│                                                                  │
│  REST                          State machines                    │
│  ──────                        ──────────────                    │
│  POST   /facts                 Workflow:                         │
│  GET    /facts?since_sequence=  created → published → matched →  │
│  POST   /facts/:id/claim         claimed → resolved │ dead       │
│  POST   /facts/:id/resolve                                       │
│  POST   /facts/:id/release     Epistemic:                        │
│  POST   /facts/:id/corroborate  asserted → corroborated →        │
│  POST   /facts/:id/contradict     consensus                      │
│  GET    /facts/:id/causation                  └→ contested →     │
│  POST   /ants/connect                            refuted         │
│  GET    /stats                                                   │
│                                                                  │
│  Background:                                                     │
│  - TTL sweep (10s)                                               │
│  - GC of resolved/dead facts (60s)                               │
│  - JSONL log compaction (1h)                                     │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTP/1.1
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                  antlegion-mcp                                    │
│  (antlegion-mcp/, stdio MCP server, ~400 lines)                   │
│                                                                   │
│  Tools (visible to the LLM client)                                │
│  ─────────────────────────────────                                │
│  antlegion_publish     antlegion_resolve                          │
│  antlegion_query       antlegion_observe                          │
│  antlegion_claim       antlegion_causation                        │
│                                                                   │
│  Resources                                                        │
│  ─────────                                                        │
│  antlegion://facts/recent                                         │
│  antlegion://facts/pending                                        │
│                                                                   │
│  Hidden from the client (handled inside the adapter):             │
│  - content_hash computation                                       │
│  - ant registration & token                                       │
│  - signature verification                                         │
│  - semantic_kind / domain_tags / need_capabilities defaults       │
│  - causation_chain / causation_depth bookkeeping                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ stdio (MCP protocol)
                               │
       ┌──────┬──────┬─────────┴─────┬──────┬──────┬──────┐
       ▼      ▼      ▼               ▼      ▼      ▼      ▼
   Claude  Cursor  Cline  Continue  Codex Windsurf Goose  …
    Code                              CLI
```

## Client-driven polling

The bus does not push. Every client runs its own scan loop:

```
let cursor = 0
loop forever:
    result = antlegion_query(since_sequence=cursor, limit=50)
    for fact in result.facts:
        // decide whether this fact concerns you
        if fact.fact_type in your_interests:
            handle(fact)
    cursor = result.next_cursor
    sleep(your_chosen_interval)
```

For a Claude Code session, the "loop" is the human typing prompts. For Cline,
it's the user clicking. For a daemon, it's a real `setInterval`. The bus
doesn't care.

This is the same model as `git fetch`: an append-only log with a cursor.

## Two state machines, one Fact

Each fact carries two orthogonal pieces of state.

**Workflow state** — managed by the bus engine, tracks where the fact is in
its processing lifecycle:

```
created ──publish──▶ published ──match──▶ matched ──claim──▶ claimed ──resolve──▶ resolved
                          │                  │                   │
                          └──── ttl ─────────┴──── ttl ──────────┴────▶ dead
```

**Epistemic state** — derived from corroborate/contradict votes by other ants,
tracks how trustworthy the fact is:

```
                      corroborate ≥ quorum
asserted ◀──contradict── corroborated ──corroborate── consensus
   │
   │── contradict
   ▼
contested ──contradict ≥ quorum──▶ refuted

(orthogonal) superseded — set whenever a newer fact with the same
                          subject_key (or explicit `supersedes`) appears.
```

These never affect each other directly. A resolved fact can still be
contradicted by a new contradict vote; a refuted fact can still be claimed
and resolved (though no sensible client would).

## What gets persisted, what stays in memory

- **In memory** (rebuilt from disk on boot): the `Map<fact_id, Fact>` and
  the active ant registry.
- **On disk** (`/data/facts.jsonl`, append-only): every publish, claim,
  resolve, release, supersede, corroborate, contradict, purge. The bus replays
  the JSONL log on startup to reconstruct memory state.
- **Compacted hourly**: stale entries (events about purged facts) are removed
  from the JSONL during the compaction tick.

Crash recovery is automatic. Pull the plug, restart, the bus comes up with the
same facts in the same states.

## Auth model

Two layers, both optional.

1. **Bus signing secret** (`ANTLEGION_BUS_SECRET`): every accepted fact is
   HMAC-signed by the bus. Clients can verify a fact's `signature` against
   this secret. If you don't set the env var, the bus generates a fresh
   random secret on each boot and signatures cannot survive restarts.

2. **Per-ant token**: returned by `POST /ants/connect`. Required for
   `claim` / `resolve` / `release` (so one ant cannot resolve another's
   claim). For `publish`, the token is **optional** — the bus accepts
   anonymous publishes for one-shot scripts and webhook gateways.

The MCP server hides both layers from the client.

## Non-goals

- No leader election, no consensus across multiple bus instances. Run one bus
  per environment.
- No native streaming push. Clients poll.
- No SDK in any language other than the in-tree TS MCP adapter. Other
  clients use MCP, full stop.
- No orchestration / workflow primitives. The bus does not know that
  `prd.published → api.published → frontend.done` is a "pipeline". If you
  want that, write a client that watches and acts on it.
