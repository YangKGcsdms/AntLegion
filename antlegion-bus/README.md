<div align="center">

🌐 **English** · [简体中文](README.zh-CN.md)

</div>

# @antlegion/bus

An append-only **fact bus** for autonomous agents — *facts, not commands*.
Agents publish, read, claim, and resolve immutable content-addressed facts;
they never address each other. Coordination (exactly-once claims, trust,
supersession, causation) emerges from a single total order and is computed
client-side as pure **reader folds** — the bus itself stays stateless.

This package is the complete implementation: the trusted core (HTTP server),
the folding SDK, the `alctl` CLI, and the MCP stdio adapter.

## Quick start

**1. Boot a bus** (five seconds, zero config):

```bash
npx @antlegion/bus        # → http://localhost:28090
```

**2. Give any MCP-capable agent fact-bus tools** (Claude Code, Cursor, Cline, …):

```bash
claude mcp add antlegion -- npx -y -p @antlegion/bus antlegion-mcp
```

Two agents connected this way coordinate through the fact stream alone:
one publishes `task.todo` facts, the other claims and resolves them —
exactly-once, no orchestrator.

**3. Talk to it from the shell** with `alctl`:

```bash
npx -p @antlegion/bus alctl publish task.todo '{"title":"hello"}'
npx -p @antlegion/bus alctl tail --follow
npx -p @antlegion/bus alctl info
```

**4. Watch it live** — the bus serves two read-only pages: `/dashboard` (demo board) and **`/console`** (ops console: `tail -f` the fact stream with filters + INFO health view).

```bash
# they're printed at startup:
# dashboard → http://127.0.0.1:28090/dashboard · console → http://127.0.0.1:28090/console
```

## From source

```bash
npm install
npm run dev          # tsx src/index.ts → http://localhost:28090 (fsync=everysec)
npm run build && npm run start
```

```bash
curl http://localhost:28090/health
# {"status":"ok","protocol":"2.0","head_seq":0}

curl http://localhost:28090/info | jq
# head_seq, facts, log_bytes, fsync, dedup_hits, sig_failures, max_depth, uptime_seconds

curl "http://localhost:28090/facts?since=0" | jq

node dist/bin.js info          # alctl CLI (after build)
npm run mcp                    # MCP stdio adapter (after build)
npm run bench                  # throughput benchmark (~160k appends/s in-process)
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `28090` | HTTP listen port |
| `HOST` | `127.0.0.1` | Listen address. The bus trusts its callers (Redis-shaped security model) — set `0.0.0.0` only inside a trust boundary (e.g. a docker network) |
| `ANTLEGION_DATA_DIR` | `.data-v2` | Append-only log directory (`facts-v2.jsonl` inside) |
| `ANTLEGION_FSYNC` | `everysec` | `always` · `everysec` · `no` — mirrors Redis `appendfsync` |
| `ANTLEGION_BUS_SECRET` | random per boot | HMAC signing secret; **set a stable value** so signatures verify across restarts |
| `ANTLEGION_MAX_DEPTH` | `64` | Causation chain depth cap (§5 safety rule) |

Clients (`alctl` CLI, SDK, MCP adapter):

| Variable | Default | Purpose |
|---|---|---|
| `ANTLEGION_BUS_URL` | `http://localhost:28090` | Bus URL for the CLI / SDK / MCP adapter |
| `ANTLEGION_AUTHOR` | `<os-username>@<hostname>` | CLI identity; `--author <name>` overrides per command |
| `ANTLEGION_AGENT_NAME` | `<os-username>@<hostname>` | MCP adapter identity (printed to stderr at startup) |

`alctl` prints machine-readable JSON on stdout (e.g. `{"id":…,"seq":…,"deduped":…}`,
`{"won":…,"winner":…}`, `{"state":…,"owner":…}`) and human errors on stderr with a
non-zero exit — including `resolve` when you're not the claim winner. `tail` prints
the stream once and exits; `tail --follow` polls live. Subpath imports
(`antlegion-bus/client`, `antlegion-bus/bus`, `antlegion-bus/fold`, …) are mapped in
`package.json` `exports`.

## Tests

```bash
npm test           # vitest run (147)
npm run test:watch # vitest watch
```

## Conformance vectors

```bash
npx tsx conformance/generate.ts  # regenerate vectors.json — only on intentional protocol changes
python3 conformance/verify.py    # independent Python reimplementation; 0 failures = cross-language proof
```

## Tech stack

Node.js ≥ 18, TypeScript 5.x, Hono, `@hono/node-server`,
`@modelcontextprotocol/sdk`, Vitest.

## License

MIT.
