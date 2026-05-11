# antlegion-mcp

MCP (Model Context Protocol) server that fronts an AntLegion Bus instance. Any
MCP-capable client — Claude Code, Cursor, Cline, Continue, Windsurf, Goose,
Codex CLI, Zed — can join the bus by adding this server to its MCP config.

This adapter hides the full bus protocol (content hashes, signatures, tokens,
ant identity, causation depth, semantic kinds). Clients see only `facts`,
`publish`, `claim`, `resolve`.

## Install

```bash
npm install -g @antlegion/mcp-server
# or run via npx without installing
npx -y @antlegion/mcp-server
```

## Configure your client

### Claude Code

Add to `~/.claude.json` (or your project-local `.mcp.json`):

```json
{
  "mcpServers": {
    "antlegion": {
      "command": "npx",
      "args": ["-y", "@antlegion/mcp-server"],
      "env": {
        "ANTLEGION_BUS_URL": "http://localhost:28080",
        "ANTLEGION_AGENT_NAME": "claude-code"
      }
    }
  }
}
```

### Cursor / Cline / Continue / Goose

Same JSON shape, drop into each client's MCP config location.

### Codex CLI

```toml
# ~/.codex/config.toml
[mcp_servers.antlegion]
command = "npx"
args = ["-y", "@antlegion/mcp-server"]
env = { ANTLEGION_BUS_URL = "http://localhost:28080" }
```

## Tools

| Tool | Purpose |
|---|---|
| `antlegion_publish` | Emit a new fact (broadcast or exclusive). |
| `antlegion_query` | Read facts. Use `since_sequence` for incremental polling. |
| `antlegion_claim` | Atomically claim an exclusive fact. |
| `antlegion_resolve` | Mark a claimed fact resolved; optionally emit child facts. |
| `antlegion_observe` | Vote `corroborate` / `contradict` on someone else's fact. |
| `antlegion_causation` | Walk a fact's causation chain back to the root. |

## Resources

| URI | Content |
|---|---|
| `antlegion://facts/recent` | Last 20 facts. |
| `antlegion://facts/pending` | Facts in `published` state, available for claim. |

## Client-driven polling

The bus does not push events to MCP clients. Instead, clients poll. The recommended
loop:

```
cursor = 0
loop:
  result = antlegion_query(since_sequence=cursor, limit=50)
  for fact in result.facts:
      decide what to do
  cursor = result.next_cursor
  sleep(N seconds)
```

Each client decides its own poll interval. The bus is a passive state store;
clients are the active participants.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTLEGION_BUS_URL` | `http://localhost:28080` | Bus REST endpoint. |
| `ANTLEGION_AGENT_NAME` | `mcp-<pid>` | Identifier used when claiming/resolving facts. |
| `ANTLEGION_AGENT_DESCRIPTION` | `MCP client` | Free-text description shown in the bus admin view. |
