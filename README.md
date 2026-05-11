# AntLegion Bus

> A **fact bus** for autonomous agents. One protocol, one server, one MCP adapter.
> Connect Claude Code, Cursor, Cline, Continue, Codex CLI, or any other
> MCP-capable client by adding one line to their config.

---

## What this is

A small, opinionated server that stores **immutable facts** with a causation
chain, content-hash integrity, and a two-axis state model (workflow ⊥
epistemic). Agents publish facts, query for them, optionally claim exclusive
ones, and resolve them.

A second, small server (`antlegion-mcp/`) exposes the bus over the **Model
Context Protocol**. Any MCP-capable client speaks to the bus through six tools.

That is the whole product.

```
┌──────────────────────────────────────────────────────────┐
│  AntLegion Bus  (antlegion-bus/)                          │
│  REST + JSONL store + content_hash + two state machines   │
└────────────────────────┬─────────────────────────────────┘
                         │
                         │  HTTP
                         │
┌────────────────────────▼─────────────────────────────────┐
│  MCP Server  (antlegion-mcp/)                             │
│  stdio, 6 tools, 2 resources                              │
└────────────────────────┬─────────────────────────────────┘
                         │
       ┌──────┬──────┬───┴────┬──────┬──────┬─────┐
       ▼      ▼      ▼        ▼      ▼      ▼     ▼
   Claude  Cursor Cline Continue Codex Windsurf Goose  …
    Code                          CLI
       (each client runs its own polling loop)
```

There is **no orchestrator**, **no broker push**, **no agent runtime**. Clients
drive their own scan loop on whatever cadence they need. The bus is a passive
state store.

---

## Quickstart (3 minutes)

### 1. Start the bus

```bash
cp .env.example .env
docker compose up -d
curl http://localhost:28080/health
```

### 2. Build & install the MCP server

```bash
cd antlegion-mcp
npm install
npm run build
npm link               # optional, so `antlegion-mcp` is on your PATH
```

### 3. Wire it into your client

Claude Code: edit `~/.claude.json`:

```json
{
  "mcpServers": {
    "antlegion": {
      "command": "node",
      "args": ["/absolute/path/to/antlegion-mcp/dist/index.js"],
      "env": {
        "ANTLEGION_BUS_URL": "http://localhost:28080",
        "ANTLEGION_AGENT_NAME": "claude-code"
      }
    }
  }
}
```

Cursor / Cline / Codex CLI / Goose / etc.: drop the equivalent JSON/TOML into
their MCP config location. See [`antlegion-mcp/README.md`](antlegion-mcp/README.md).

### 4. Talk to the bus in plain English

```
You: 在 bus 上发一条 fact，类型是 demo.hello，payload 写 "first contact"
Claude: [tool] antlegion_publish({ fact_type: "demo.hello", payload: { msg: "first contact" } })
Claude: 发出，fact_id=8f3a..., sequence=1

You: 看一下 bus 上最近有什么
Claude: [tool] antlegion_query({ limit: 5 })
Claude: 当前 1 条 fact: demo.hello "first contact" 来自 claude-code
```

---

## The "fact bus" idea in 60 seconds

Most agent frameworks pass messages: agent A calls agent B, B returns to A.
This couples them. AntLegion takes a different path borrowed from CAN-bus and
event sourcing:

| | Message passing | Fact bus |
|---|---|---|
| Connection | A knows B's address | A and B both connect to the bus |
| Persistence | Message is a transient event | Fact is immutable, content-hashed, persisted |
| Provenance | Hard to reconstruct | Causation chain on every fact |
| Trust | Implicit (you trust the sender) | Explicit `epistemic_state`: asserted → corroborated → consensus, or → contested → refuted |
| Routing | Direct | Filter on type / capabilities / domain |
| Exclusivity | Each receiver gets its own copy | `exclusive` mode → exactly one consumer claims and resolves |

Facts have a `sequence_number` that is monotonically increasing. Clients poll
with `since_sequence=N` and only get new facts. This is closer in spirit to
`git fetch` than to a message queue.

For a deeper protocol reference see [`antlegion-bus/DESIGN.md`](antlegion-bus/DESIGN.md).

---

## Repository layout

```
.
├── antlegion-bus/         # The bus server (Hono + JSONL)
├── antlegion-mcp/         # The MCP adapter (stdio, 6 tools)
├── docs/                  # Architecture and design notes
├── docker-compose.yml     # Spins up just the bus
└── .env.example
```

---

## When this fits, and when it doesn't

**Fits:**
- Multiple independent agents that should share state without direct calls.
- You need a complete provenance record (compliance, audit, research).
- Loose coupling: agents may come and go; clients may be CLI scripts, IDEs,
  cron jobs, MCP clients, or long-running daemons.
- You want a single source of truth that survives any one client crashing.

**Does not fit:**
- Tight request/response RPCs between two known endpoints. Use HTTP.
- High-throughput event streams (>1k events/sec sustained). Use Kafka/NATS.
- Workflows with strong sequential dependencies enforced by a central planner.
  The bus has no orchestrator; if you need one, write a client that *is* one.

---

## What happened to the old multi-agent SDLC demo?

The previous incarnation of this repository shipped a 3,000-line agent runtime
plus five docker containers (PM / UI designer / backend / frontend / QA) that
collaborated through fact subscriptions to auto-generate Todo CRUD apps.

That code is preserved on the
[`archive/legacy-emergent-runtime`](https://github.com/YangKGcsdms/antlegion-platform/tree/archive/legacy-emergent-runtime)
branch. It is not deleted, just retired from the trunk.

The retirement is intentional. The fact bus is the durable asset; the 5-agent
SDLC demo was a workaround for there being no way for *external* agents (Claude
Code, Cursor, …) to connect. With the MCP adapter, that workaround is no longer
needed. See [`docs/EVOLUTION.md`](docs/EVOLUTION.md) for the full reasoning.

---

## License

MIT. See [`LICENSE`](LICENSE).
