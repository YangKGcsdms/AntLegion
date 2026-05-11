# antlegion-bus

The bus server. Stores facts, dispatches events, arbitrates exclusive claims.

For the project overview see [`../README.md`](../README.md).
For the wire protocol see [`../PROTOCOL.md`](../PROTOCOL.md).

## Run

```bash
npm install
npm run build
npm start
```

Listens on port 28080 by default.

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
