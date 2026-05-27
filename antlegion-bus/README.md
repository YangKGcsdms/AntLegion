# antlegion-bus

The fact-bus server. This package contains **two generations** (see
[`../README.md`](../README.md) for the project overview):

- **v2 (current)** — `src/v2/`: a stateless append-only fact log; meaning is a
  reader fold in the SDK/CLI. Protocol: [`../PROTOCOL.md`](../PROTOCOL.md).
- **v1 (legacy)** — `src/`: the original mutable-state engine. Protocol:
  [`../PROTOCOL-v1-historical.md`](../PROTOCOL-v1-historical.md).

## Run — v2 (current)

```bash
npm install
npm run dev:v2          # tsx src/v2/index.ts → http://localhost:28090
#   or: npm run build && npm run start:v2
```

```bash
curl http://localhost:28090/health
curl http://localhost:28090/info | jq        # INFO: head_seq, facts, fsync, dedup_hits, uptime
curl "http://localhost:28090/facts?since=0" | jq
node dist/v2/bin.js info                      # alctl CLI (after build)
npm run bench:v2                              # throughput benchmark
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `28090` | HTTP listen port |
| `ANTLEGION_DATA_DIR` | `.data-v2` | append-only log directory (AOF) |
| `ANTLEGION_FSYNC` | `everysec` | `always` \| `everysec` \| `no` (redis `appendfsync`) |
| `ANTLEGION_BUS_SECRET` | random per boot | HMAC secret; set a stable value so signatures verify across restarts |

## Run — v1 (legacy)

```bash
npm run build
npm start                # node dist/index.js → http://localhost:28080
```

```bash
curl http://localhost:28080/health
curl http://localhost:28080/facts | jq
curl http://localhost:28080/stats | jq
curl http://localhost:28080/facts/cursor   # current head sequence
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `28080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `ANTLEGION_DATA_DIR` | `.data` | Directory for the JSONL append log |
| `ANTLEGION_BUS_SECRET` | random per boot | HMAC secret for fact signatures. Set to a stable value in production. (Legacy alias `FACT_BUS_SECRET` is still accepted.) |

## Tests

```bash
npm test           # vitest run
npm run test:watch # vitest watch
```

## Tech stack

Node.js 22+, TypeScript 5.7+, Hono, `@hono/node-server`, self-built JSONL
append-only log (`src/persistence/JSONLStore.ts`), Vitest.

## License

MIT.
