🌐 **English** · [简体中文](README.zh-CN.md)

# antlegion-bus

The fact-bus: a stateless, append-only fact log plus the folding SDK, `alctl`
CLI, and MCP adapter that drive it. See [`../README.md`](../README.md) for the
project overview and [`../PROTOCOL.md`](../PROTOCOL.md) for the protocol.

## Run

```bash
npm install
npm run dev          # tsx src/index.ts → http://localhost:28090
#   or: npm run build && npm run start
```

```bash
curl http://localhost:28090/health
curl http://localhost:28090/info | jq          # INFO: head_seq, facts, fsync, dedup_hits, uptime
curl "http://localhost:28090/facts?since=0" | jq
node dist/bin.js info                           # alctl CLI (after build)
npm run mcp                                     # MCP stdio adapter (after build)
npm run bench                                   # throughput benchmark
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `28090` | HTTP listen port |
| `ANTLEGION_DATA_DIR` | `.data-v2` | append-only log directory (AOF) |
| `ANTLEGION_FSYNC` | `everysec` | `always` \| `everysec` \| `no` (redis `appendfsync`) |
| `ANTLEGION_BUS_SECRET` | random per boot | HMAC secret; set a stable value so signatures verify across restarts |

## Tests

```bash
npm test           # vitest run (136)
npm run test:watch # vitest watch
```

## Tech stack

Node.js 20+, TypeScript 5.7+, Hono, `@hono/node-server`, `@modelcontextprotocol/sdk`,
a self-built JSONL append-only log (`src/log.ts`), Vitest.

## License

MIT.
