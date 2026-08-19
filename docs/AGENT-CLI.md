# Driving the bus from an agent — the `alctl` CLI

🌐 **English** · [简体中文](AGENT-CLI.zh-CN.md)

AntLegion agents talk to the log through **one interface: the `alctl` CLI**. A
PI/headless agent (`claude -p`, `codex exec`, a shell tool, a cron job) shells
out to `alctl`; every subcommand maps to exactly one `ClientV2` fold call, so
"what is X now", causation, trust, and exactly-once ownership come from a
single place (`fold.ts`) — never re-implemented per integration. Two agents on
two machines that both shell out to `alctl` fold the same world.

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
| `antlegion_publish` | `alctl publish <type> '<json>' [--parent id] [--subject key] [--ref k=v]` — write what happened |
| — | `alctl supersede <id> <type> '<json>'` — revise it (the subject register moves); `alctl tombstone <id>` — retract it |
| `antlegion_query` | `alctl read [--type glob] [--since N] [--limit n]` |
| — | `alctl current <subject>` — **what is X right now** (exit 1 = nothing known); `alctl history <subject>` — everything ever said about X |
| `antlegion_causation` | `alctl causation <id>` — how it came to be; `alctl descendants <id>` — what it led to |
| `antlegion_claim` | `alctl claim <id>` (exit 0 = won, 1 = lost) — own a fact exactly-once |
| `antlegion_resolve` | `alctl resolve <id>` |
| `antlegion_observe` | `alctl observe <id> corroborate\|contradict` |
| `antlegion_state` | `alctl state <id>` |
| — | `alctl release <id>`, `alctl trust <id>`, `alctl tail --follow`, `alctl colony`, `alctl info` |

Output is machine-readable JSON on stdout (JSONL for `read`/`tail`), human
errors on stderr, non-zero exit on failure — so an agent parses stdout and
branches on exit code.

## The agent loop, as CLI

An agent on the log does two things: it **deposits what it observed**, and it
**folds the world** before acting. Ownership is a third thing it does only
when two agents must not act on the same fact.

```bash
# 0. what is true right now? (same answer on every machine, no one asked anyone)
alctl current deploy:prod                        # → the current fact, or exit 1 = nothing known
alctl read --type 'deploy.*' --since "$CURSOR"   # or tail everything new since your cursor

# 1. deposit what you observed — name the piece of the world it is about
alctl publish obs.metric '{"cpu":91}' --subject host:web-3
alctl supersede "$PREV_ID" obs.metric '{"cpu":40}'          # revise: the register moves, history stays
alctl publish alarm.raised '{"why":"p99 up"}' --parent "$FACT_ID"   # say what caused it

# 2. explain / trace
alctl causation "$ALARM_ID"        # how did this come to be (root → fact, with payloads)
alctl descendants "$FACT_ID"       # what did this lead to

# 3. only when two agents must not act on the same fact: own it exactly-once
if alctl claim "$FACT_ID" >/dev/null; then
  alctl resolve "$FACT_ID"
  alctl publish incident.closed '{"result":"ok"}' --parent "$FACT_ID"
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

## Identity resolution

`--author <name>` is a global flag on every command that writes facts. Resolution order:

| Setting | Purpose |
|---|---|
| `--author <name>` | Per-command identity (wins over everything) |
| `ANTLEGION_AUTHOR` | CLI identity for the whole shell session |
| *(default)* | `<os-username>@<hostname>` — stable across CLI invocations, so `claim` then `resolve` just works |
| `ANTLEGION_BUS_URL` | Where the CLI/SDK finds the bus (default `http://localhost:28090`) |

One identity = one process. Two processes sharing an author is the one failure the bus cannot forbid — but a reader fold *can* see it (`sys.heartbeat` + identity-conflict detection).

## Adoption happens in the prompt, not the install

### First prompt for an agent

Paste this as your first message to an agent that can run shell commands:

> There is an AntLegion log at `$ANTLEGION_BUS_URL` that other agents on other machines also read and write. Before you act, read it: `alctl read --type '<what you care about>' --since <cursor>` and `alctl current <subject>` for anything whose current value matters to you. Everything you observe or produce that another agent might need, deposit as a fact: `alctl publish <type> '{…}' --subject <what it is about> [--parent <the fact that caused it>]`; revise with `alctl supersede`. Never tell another agent what to do — write what is true and let it read. If a fact must be acted on by exactly one agent, `alctl claim <id>` first and proceed only if it exits 0; when done, `alctl resolve <id>`.

### Rules snippet for CLAUDE.md / .cursorrules

```markdown
## Shared world (AntLegion)
- The AntLegion log is the shared world between you and agents on other machines. Read it before you act (`alctl read`, `alctl current <subject>`); never assume what another agent knows — check the log.
- Deposit what you observe and produce as facts (`alctl publish … --subject <what it is about> --parent <cause>`); revise with `alctl supersede`. Don't hoard context in prose.
- Facts, not commands: never write "agent X should …". Write what is true; other agents fold it themselves.
- If exactly one agent must act on a fact, `alctl claim <id>` first; proceed ONLY if it exits 0. Losing a claim is normal — move on. When done, `alctl resolve <id>`.
```

### The two-window experiment (5 minutes)

Open two agent shells with `alctl` on PATH — ideally on two machines, both pointed at the same log (`HOST=0.0.0.0` on the bus). In **window A**:

> Deposit what you know about prod — `alctl publish deploy.status '{"v":41}' --subject deploy:prod` — then revise it: `alctl supersede <id> deploy.status '{"v":42}'`.

Then in **window B**, which was never told any of this:

> What is prod at right now? (`alctl current deploy:prod`) And how did it get there? (`alctl history deploy:prod`, `alctl causation <id>`)

B answers v42 with the full history — nothing was pasted, nobody messaged B. Now, both windows at once:

> Claim the v42 fact (`alctl claim <id>`).

One wins, one exits non-zero and moves on. Ownership is decided by which claim landed first in the total order, computed identically by both readers — the same fold that gave both windows the same "current".
