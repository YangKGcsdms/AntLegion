# antlegion-bus

> Server implementation of the AntLegion Bus protocol — a fact bus for
> autonomous agents.

This service stores immutable facts, signs them, dispatches them to interested
ants, and maintains two orthogonal state machines per fact (workflow ⊥
epistemic).

For the **top-level project description**, the **MCP adapter**, and how clients
connect, see the [repository README](../README.md).

---

## Protocol references

| Document | Content |
|----------|---------|
| [protocol/SPEC.zh-CN.md](protocol/SPEC.zh-CN.md) | Full protocol spec |
| [protocol/EXTENSIONS.zh-CN.md](protocol/EXTENSIONS.zh-CN.md) | Optional extensions (epistemic state, semantic kinds, fault isolation) |
| [protocol/IMPLEMENTATION-NOTES.zh-CN.md](protocol/IMPLEMENTATION-NOTES.zh-CN.md) | Recommended defaults & algorithms |
| [DESIGN.md](DESIGN.md) | Architecture, state machines, API design |

---

## Running standalone

```bash
npm install
npm run build
npm start
```

The bus listens on port 28080 by default.

```bash
curl http://localhost:28080/health
curl http://localhost:28080/facts | jq
curl http://localhost:28080/stats | jq
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `28080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `ANTLEGION_DATA_DIR` | `.data` | Directory for the JSONL append log |
| `ANTLEGION_BUS_SECRET` | random per boot | HMAC secret for fact signatures. Set to a stable value in production. (Legacy alias `FACT_BUS_SECRET` is still accepted.) |

## Tech stack

- Node.js 22+ / TypeScript 5.7+
- Hono + `@hono/node-server`
- JSONL append-only log (self-built, see `src/persistence/JSONLStore.ts`)
- Vitest

## License

MIT
