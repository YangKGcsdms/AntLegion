<div align="center">

🌐 **English** · [简体中文](README.zh-CN.md)

</div>

# antlegion-bus

The `antlegion-bus` package is the complete AntLegion v2 implementation:
a stateless, append-only fact log (the trusted core), the folding SDK,
the `alctl` CLI, and the MCP stdio adapter.

## Run

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
| `ANTLEGION_DATA_DIR` | `.data-v2` | Append-only log directory (`facts-v2.jsonl` inside) |
| `ANTLEGION_FSYNC` | `everysec` | `always` · `everysec` · `no` — mirrors Redis `appendfsync` |
| `ANTLEGION_BUS_SECRET` | random per boot | HMAC signing secret; **set a stable value** so signatures verify across restarts |
| `ANTLEGION_MAX_DEPTH` | `64` | Causation chain depth cap (§5 safety rule) |

## Tests

```bash
npm test           # vitest run (136)
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
