<!-- lang-nav --> 🌐 **English** · [简体中文](QUICKSTART-v1-mcp.zh-CN.md)

# Quickstart — Claude Code + AntLegion Bus (v1 / MCP · legacy)

> ⚠️ **Legacy.** This walks through the **v1** bus (`antlegion-bus/src/`, port
> 28080) and the **MCP adapter** (`antlegion-mcp/`). It is kept because the MCP
> adapter is currently the only zero-code way for MCP clients (Claude Code,
> Cursor, …) to join a bus. For the current **v2** fact bus (CLI + SDK + AOF),
> see [`QUICKSTART.md`](QUICKSTART.md) and [`PROTOCOL.md`](PROTOCOL.md).

Five minutes from cloning the repo to publishing your first fact through
Claude Code.

## Prerequisites

- Docker + Docker Compose
- Node.js 20+
- Claude Code installed and logged in

## 1. Start the bus

```bash
cp .env.example .env
docker compose up -d
```

Verify:

```bash
curl http://localhost:28080/health
# → {"status":"ok","timestamp":...}
```

## 2. Build the MCP server

```bash
cd antlegion-mcp
npm install
npm run build
```

Quick smoke test (stdio echoes JSON-RPC; type Ctrl-D to exit):

```bash
node dist/index.js
# stderr: [antlegion-mcp] connected to bus at http://localhost:28080
```

## 3. Register the server with Claude Code

Edit `~/.claude.json`. Add (or merge into) the `mcpServers` block:

```json
{
  "mcpServers": {
    "antlegion": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/antlegion-platform/antlegion-mcp/dist/index.js"],
      "env": {
        "ANTLEGION_BUS_URL": "http://localhost:28080",
        "ANTLEGION_AGENT_NAME": "claude-code"
      }
    }
  }
}
```

Restart any open Claude Code session.

## 4. Use it

In Claude Code:

```
You: 在 antlegion bus 上发一条 fact，type 是 demo.hello，payload 写 {"msg":"first contact"}

Claude: I'll publish that fact for you.
[tool call] antlegion_publish({
  "fact_type": "demo.hello",
  "payload": { "msg": "first contact" }
})
[tool result] { "fact_id": "8f3a...", "state": "published", "sequence_number": 1 }

Done. Fact 8f3a... is now on the bus at sequence 1.
```

Confirm directly:

```bash
curl http://localhost:28080/facts | jq '.[0]'
```

You should see your fact with a `content_hash` and `signature` computed by the
bus.

## 5. Try the causation chain

```
You: 帮我针对刚才那条 fact 发一个 follow-up，fact_type "demo.reply"，payload 是
     {"reply": "ack"}，记得设 parent_fact_id

Claude: [tool] antlegion_query({ fact_type: "demo.hello", limit: 1 })
[result] facts[0].fact_id = "8f3a..."

[tool] antlegion_publish({
  "fact_type": "demo.reply",
  "payload": { "reply": "ack" },
  "parent_fact_id": "8f3a..."
})

[tool] antlegion_causation({ fact_id: <new id> })
[result] chain_length: 2 — root demo.hello, then demo.reply
```

The causation chain is automatic. Every fact knows its ancestors.

## 6. Try exclusive claim/resolve

This is the "exactly one consumer" pattern. Open a second terminal with
another MCP client (or call the REST API directly):

```
Terminal A — Claude Code:
You: 发一条 exclusive fact，type "task.do-something"，payload {"detail": "..."}
Claude: [tool] antlegion_publish({
  fact_type: "task.do-something",
  payload: { detail: "..." },
  mode: "exclusive"
})

Terminal B — curl, simulating another client:
$ curl http://localhost:28080/facts?fact_type=task.do-something&state=published
[{ "fact_id": "<id>", ... }]

$ # claim it
$ curl -X POST http://localhost:28080/facts/<id>/claim \
    -H 'Content-Type: application/json' \
    -d '{"ant_id":"someone-else","token":""}'
# → {"success": true, ...}

Terminal A — Claude Code:
You: 试着 claim 一下那条 task.do-something
Claude: [tool] antlegion_claim({ fact_id: <id> })
[result] error: "already claimed by someone-else"
```

The bus enforced exclusivity. Without an orchestrator, without a leader
election, with one HTTP call.

## Where to go next

- [README.md](README.md) — overview, architecture diagram, the 6 MCP tools at a glance
- [PROTOCOL.md](PROTOCOL.md) — wire-level protocol reference (Fact model, state machines, REST API, signing, extensions)
- [EVOLUTION.md](EVOLUTION.md) — why the project looks like this
- [antlegion-mcp/README.md](antlegion-mcp/README.md) — every tool parameter, every client config snippet
