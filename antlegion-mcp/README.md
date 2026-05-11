# antlegion-mcp

MCP (Model Context Protocol) server that fronts an AntLegion Bus instance.
Any MCP-capable client — Claude Code, Cursor, Cline, Continue, Windsurf,
Goose, Codex CLI, Zed — joins the bus by adding this server to its MCP
config.

For the project overview see [`../README.md`](../README.md).
For the bus protocol see [`../PROTOCOL.md`](../PROTOCOL.md).
For the full walkthrough see [`../QUICKSTART.md`](../QUICKSTART.md).

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
cursor = 0
loop:
  result = antlegion_query(since_sequence=cursor, limit=50)
  for fact in result.facts:
      decide what to do
  cursor = result.next_cursor
  sleep(your_interval)
```

For a Claude Code session, the "loop" is the human typing. For a daemon, it
is a real `setInterval`. The bus does not care.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTLEGION_BUS_URL` | `http://localhost:28080` | Bus REST endpoint. |
| `ANTLEGION_AGENT_NAME` | `mcp-<pid>` | Identifier used when claiming / resolving facts. |
| `ANTLEGION_AGENT_DESCRIPTION` | `MCP client` | Free-text description shown in the bus admin view. |

## License

MIT.
