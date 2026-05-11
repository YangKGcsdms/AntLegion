# AntLegion Bus

> A **fact bus** for autonomous agents. One protocol. One server. One MCP adapter.
> Connect Claude Code, Cursor, Cline, Continue, Codex CLI, Goose, or any other
> MCP-capable client by adding one line to their config.

---

## What this is

A small server that stores **immutable facts** with a causation chain,
content-hash integrity, and a two-axis state model (workflow ⊥ epistemic).
Agents publish facts, query for them, optionally claim exclusive ones, and
resolve them.

A second server (`antlegion-mcp/`) exposes the bus over the **Model Context
Protocol**. Any MCP-capable client speaks to the bus through six tools.

That is the whole product. There is **no orchestrator**, **no broker push**,
**no agent runtime**. Clients drive their own scan loop on whatever cadence
they need.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  AntLegion Bus  (antlegion-bus/)                         │
│  REST + JSONL store + content hashing + signing          │
│  Two state machines per fact (workflow ⊥ epistemic)      │
└──────────────────────────┬───────────────────────────────┘
                           │  HTTP
                           │
┌──────────────────────────▼───────────────────────────────┐
│  MCP Server  (antlegion-mcp/)                             │
│  stdio · 6 tools · 2 resources                            │
│  Hides hashing, tokens, ant identity, causation depth     │
└──────────────────────────┬───────────────────────────────┘
                           │  stdio (MCP protocol)
                           │
       ┌──────┬──────┬─────┴─────┬──────┬──────┬──────┐
       ▼      ▼      ▼           ▼      ▼      ▼      ▼
   Claude  Cursor  Cline    Continue Codex Windsurf Goose
    Code                              CLI               …
       (each client runs its own polling loop)
```

The bus is a **passive state store**. Facts have a `sequence_number` that
increases monotonically; clients poll with `since_sequence=N` and get only
new facts. Closer in spirit to `git fetch` than to a message queue.

---

## The 6 MCP tools (everything a client sees)

| Tool | Purpose |
|---|---|
| `antlegion_publish` | Emit a new fact. Broadcast (shared context) or exclusive (one consumer claims). |
| `antlegion_query` | Read facts. Use `since_sequence` for incremental polling. |
| `antlegion_claim` | Atomically claim an exclusive fact. |
| `antlegion_resolve` | Mark a claimed fact resolved. Optionally emit child facts. |
| `antlegion_observe` | Vote `corroborate` / `contradict` on someone else's fact. |
| `antlegion_causation` | Walk a fact's causation chain back to the root. |

Plus 2 MCP resources for read-only inspection:

| URI | Content |
|---|---|
| `antlegion://facts/recent` | Last 20 facts |
| `antlegion://facts/pending` | Facts available for claim |

That is the complete surface a client implements against. No content
hashing, no signature verification, no token management, no semantic-kind
enum to memorize. The MCP adapter handles all of it.

---

## Quickstart (one command)

```bash
./deploy.sh
```

This does everything: starts the bus via docker compose, builds the MCP server,
waits for `/health` to come up, then generates a local `setup.html` with
copy-paste-ready MCP config snippets (the absolute paths are baked in for your
machine). It tries to auto-open the page; if not, just open `setup.html` in
your browser and pick your client.

### Manual steps (if you prefer)

```bash
# 1. Start the bus
cp .env.example .env
docker compose up -d

# 2. Build the MCP server
cd antlegion-mcp && npm install && npm run build && cd ..

# 3. Wire it into Claude Code (~/.claude.json)
#    See QUICKSTART.md for the exact JSON
```

Then in Claude Code:

```
You: 在 bus 上发一条 fact，type 是 demo.hello，payload {"msg":"first contact"}
Claude: [tool] antlegion_publish({ fact_type: "demo.hello", payload: { msg: "first contact" } })
        [result] { fact_id: "8f3a...", state: "published", sequence_number: 1 }
        Done.
```

Full walkthrough: [QUICKSTART.md](QUICKSTART.md).

---

## The "fact bus" idea, briefly

Most agent frameworks pass messages: A calls B, B returns to A. This couples
them. AntLegion takes a different path borrowed from CAN-bus and event
sourcing:

| | Message passing | Fact bus |
|---|---|---|
| Connection | A knows B's address | A and B both connect to the bus |
| Persistence | Message is transient | Fact is immutable, content-hashed, persisted |
| Provenance | Hard to reconstruct | Causation chain on every fact |
| Trust | Implicit | Explicit `epistemic_state`: asserted → corroborated → consensus, or → contested → refuted |
| Routing | Direct | Content-based filter on type / capabilities / domain |
| Exclusivity | Each receiver gets its own copy | `exclusive` mode → exactly one consumer claims |

For the complete protocol see [PROTOCOL.md](PROTOCOL.md).

---

## Repository layout

```
.
├── README.md            ← you are here
├── PROTOCOL.md          ← wire protocol reference (Fact, state machines, REST API, signing, extensions)
├── QUICKSTART.md        ← 5-minute Claude Code walkthrough
├── EVOLUTION.md         ← why the project looks like this
├── docker-compose.yml   ← spins up just the bus
├── antlegion-bus/       ← bus server (Hono + JSONL)
└── antlegion-mcp/       ← MCP adapter (stdio, 6 tools)
```

---

## When this fits, and when it doesn't

**Fits:**
- Multiple independent agents that share state without direct calls.
- You need a complete provenance record (compliance, audit, research).
- Loose coupling: agents may come and go; clients may be CLI scripts, IDEs,
  cron jobs, MCP clients, or long-running daemons.
- You want a single source of truth that survives any one client crashing.

**Does not fit:**
- Tight request/response RPCs between two known endpoints. Use HTTP.
- High-throughput event streams (>1k events/sec sustained). Use Kafka / NATS.
- Workflows with strong sequential dependencies enforced by a central
  planner. The bus has no orchestrator; if you need one, write a client
  that *is* one.

---

## What happened to the old multi-agent SDLC demo?

Earlier versions shipped a 3,000-line agent runtime plus five docker
containers (PM / UI / backend / frontend / QA) that collaborated through
fact subscriptions to auto-generate Todo CRUD apps. That code is preserved
on the [`archive/legacy-emergent-runtime`](https://github.com/YangKGcsdms/antlegion-platform/tree/archive/legacy-emergent-runtime)
branch. Full reasoning in [EVOLUTION.md](EVOLUTION.md).

Short version: with MCP available, no internal runtime is needed. Every
external client can join the bus directly.

---

## License

MIT. See [LICENSE](LICENSE).
