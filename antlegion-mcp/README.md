# antlegion-mcp (v1 / legacy)

> ⚠️ **Legacy.** This adapter fronts the **v1** bus (`../antlegion-bus/src/`,
> port 28080). It is retained because it is currently the only zero-code way for
> MCP clients to join a bus; a **v2** MCP adapter is planned. For the current v2
> fact bus, use its SDK/CLI directly — see [`../QUICKSTART.md`](../QUICKSTART.md)
> and [`../PROTOCOL.md`](../PROTOCOL.md).

MCP (Model Context Protocol) server that fronts an AntLegion Bus instance.
Any MCP-capable client — Claude Code, Cursor, Cline, Continue, Windsurf,
Goose, Codex CLI, Zed — joins the bus by adding this server to its MCP
config.

For the project overview see [`../README.md`](../README.md).
For the v1 bus protocol see [`../PROTOCOL-v1-historical.md`](../PROTOCOL-v1-historical.md).
For the full v1 walkthrough see [`../QUICKSTART-v1-mcp.md`](../QUICKSTART-v1-mcp.md).

This adapter hides the bus protocol's complexity (content hashes, signatures,
tokens, ant identity, causation depth, semantic kinds). Clients see only
`facts`, `publish`, `claim`, `resolve`, `observe`, `causation`.

## Install

```bash
npm install
npm run build
# optional: npm link    so `antlegion-mcp` is on your PATH
```

## Configure your client

### Claude Code — `~/.claude.json` (or project-local `.mcp.json`)

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

### Cursor / Cline / Continue / Goose / Windsurf

Same JSON shape, drop it into each client's MCP config location.

### Codex CLI — `~/.codex/config.toml`

```toml
[mcp_servers.antlegion]
command = "node"
args = ["/absolute/path/to/antlegion-mcp/dist/index.js"]
env = { ANTLEGION_BUS_URL = "http://localhost:28080" }
```

## Tools

| Tool | Purpose |
|---|---|
| `antlegion_publish` | Emit a new fact (broadcast or exclusive). |
| `antlegion_query` | Read facts. Pass `since_sequence` for incremental polling. |
| `antlegion_claim` | Atomically claim an exclusive fact. |
| `antlegion_resolve` | Mark a claimed fact resolved; optionally emit child facts. |
| `antlegion_observe` | Vote `corroborate` / `contradict` on someone else's fact. |
| `antlegion_causation` | Walk a fact's causation chain back to the root. |

Every parameter is documented in the tool's `inputSchema`; check the MCP
inspector or the client's tool-listing UI.

## Resources

| URI | Content |
|---|---|
| `antlegion://facts/recent` | Last 20 facts. |
| `antlegion://facts/pending` | Facts in `published` state, available for claim. |

## Client-driven polling

The bus does not push events to MCP clients. Each client decides its own
cadence:

```
loop:
  result = antlegion_query(limit=50)           # since_sequence defaults to the persisted cursor
  for fact in result.facts:
      decide what to do
  sleep(your_interval)
```

For a Claude Code session, the "loop" is the human typing. For a daemon, it
is a real `setInterval`. The bus does not care.

### Cursor persistence

The adapter persists the last-seen sequence number to
`~/.antlegion/cursor-<ANTLEGION_AGENT_NAME>.json`. This means:

- `antlegion_query` calls **automatically advance** the cursor across restarts.
- Cron-driven Codex / one-shot Claude invocations don't re-scan history from 0.
- To scan from the beginning anyway, pass `since_sequence: 0` explicitly.

### Glob queries

`antlegion_query({ fact_type: "bug.*" })` matches any fact_type with that
prefix. The bus supports `*` (any substring) and `?` (one character). A
pattern with no glob characters is matched exactly.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTLEGION_BUS_URL` | `http://localhost:28080` | Bus REST endpoint. |
| `ANTLEGION_AGENT_NAME` | `<hostname>-<pid>` | Used directly as `source_ant_id` on every operation. Set this per client (e.g. `claude-code`, `cursor`) for readable provenance. If unset, the default uniquely identifies each process so two windows/machines don't collide. |

## Identity model

The adapter does **not** register a long-lived ant with the bus. It uses
`ANTLEGION_AGENT_NAME` directly as the `source_ant_id` for every operation,
and sends no auth token. The bus accepts this (per
[`PROTOCOL.md`](../PROTOCOL.md) §7.1 — token is optional for publish, and
unregistered ant_ids are accepted for claim/resolve with reliability tracking
skipped).

Consequence: restarting Claude Code does not accumulate phantom ants on the
bus. All facts from a given client share one stable identity.

## License

MIT.
