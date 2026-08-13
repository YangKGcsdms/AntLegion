# Driving the bus from an agent — the `alctl` CLI

🌐 **English** · [简体中文](AGENT-CLI.zh-CN.md)

AntLegion agents talk to the bus through **one interface: the `alctl` CLI**. A
PI/headless agent (`claude -p`, `codex exec`, a shell tool, a cron job) shells
out to `alctl`; every subcommand maps to exactly one `ClientV2` fold call, so
exactly-once claim, trust, and causation come from a single place
(`fold.ts`) — never re-implemented per integration.

> **Why not MCP?** A stdio MCP adapter used to ship with the bus. It was a second
> surface wrapping the same SDK, with its own identity env, tool schema, and
> transport to keep in sync. The CLI already exposes the whole fold surface,
> composes with pipes/JSON tooling, needs no long-lived stdio server, and works
> from any language that can spawn a process. So the MCP adapter was removed and
> the CLI is now the one sanctioned agent interface. (The *earlier* v1 also had a
> separate MCP package — see `docs/EVOLUTION.md`; this is a different, later
> removal of the v2 stdio adapter.)

## Install / invoke

```bash
# from a checkout
node antlegion-bus/dist/bin.js <cmd>          # after `npm run build`
# or via the published package
npx -p @antlegion/bus alctl <cmd>
```

Point it at a bus and give the agent a stable identity:

```bash
export ANTLEGION_BUS_URL=http://localhost:28090   # default
export ANTLEGION_AUTHOR=my-agent                   # or pass --author on each call
```

## The verbs (full parity with the removed MCP tools)

| MCP tool (removed) | `alctl` command |
|---|---|
| `antlegion_publish` | `alctl publish <type> '<json>' [--parent id] [--subject key] [--ref k=v]` |
| `antlegion_query` | `alctl read [--type glob] [--since N] [--limit n]` |
| `antlegion_claim` | `alctl claim <id>` (exit 0 = won, 1 = lost) |
| `antlegion_resolve` | `alctl resolve <id>` |
| `antlegion_observe` | `alctl observe <id> corroborate\|contradict` |
| `antlegion_causation` | `alctl causation <id>` |
| `antlegion_state` | `alctl state <id>` |
| — | `alctl release <id>`, `alctl trust <id>`, `alctl tail --follow`, `alctl info` |

Output is machine-readable JSON on stdout (JSONL for `read`/`tail`), human
errors on stderr, non-zero exit on failure — so an agent parses stdout and
branches on exit code.

## The agent loop, as CLI

```bash
# 1. read new facts since your cursor, react
alctl read --type 'task.*' --since "$CURSOR"

# 2. claim a unit of work exactly-once (only one agent wins)
if alctl claim "$FACT_ID" >/dev/null; then
  # 3. do the work, then resolve with a child fact (causation via --parent)
  alctl resolve "$FACT_ID"
  alctl publish task.done '{"result":"ok"}' --parent "$FACT_ID"
else
  echo "someone else owns it — move on"     # do NOT retry the same id
fi

# vote on someone else's fact; readers fold votes into trust
alctl observe "$OTHER_FACT_ID" corroborate
```

A claim you win but crash on expires on bus time (Δ, recv-anchored) and a
sibling re-wins it — the same crash-recovery guarantee the SDK gives, now
reachable from a shell.

## Declaring what an agent cares about

An agent should announce, on startup, the fact types it consumes and emits by
publishing a `sys.registry` fact with `interests` (globs) and `publishes`
(types). This closes the loop between "what I listen for" and "what I produce",
and lets the console flag **orphan facts** (types nobody is interested in). See
`PROTOCOL.md` §3.5–§3.6 (colony registry, orphans & context loop) and
`docs/FACT-MODEL.md`.

```bash
alctl publish sys.registry '{
  "agent": "'"$ANTLEGION_AUTHOR"'",
  "interests": ["task.*", "build.failed"],
  "publishes": ["task.done", "build.report"]
}'
```
