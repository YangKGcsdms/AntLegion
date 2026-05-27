<!-- lang-nav --> 🌐 **English** · [简体中文](CLAUDE.zh-CN.md)

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AntLegion is a **fact bus** for autonomous agents: an append-only log of immutable, content-addressed facts that agents coordinate through. The founding axiom is **facts, not commands** — agents publish/read/claim/resolve facts and never address each other; coordination emerges from the fact stream. It is **not** a message queue, orchestrator, or agent runtime, and it is positioned as local/embeddable infrastructure (Redis-shaped), not a public SaaS.

The repo holds **two generations**, both inside the `antlegion-bus/` package:

- **v2 — current.** A first-principles redesign: one primitive (a fact in a total order), two ops (`append`/`read`); claim/resolve/trust/supersession/causation are **reader folds**, not server state. Lives in **`antlegion-bus/src/v2/`**. Spec: **`PROTOCOL.md`**. New work should target v2.
- **v1 — legacy.** The original mutable-state bus (`antlegion-bus/src/`) + the MCP adapter (`antlegion-mcp/`). Retained only because the MCP adapter is still the only zero-code path for MCP clients. Spec: `PROTOCOL-v1-historical.md`.

`PROTOCOL.md` (v2) is the **authoritative spec**; its §3 fold rules are normative (that's where meaning lives, since the v2 bus is stateless). Keep `PROTOCOL.md` and `src/v2/` in sync.

## Commands

Run inside `antlegion-bus/` (or `antlegion-mcp/`), not the repo root.

```bash
# v2 (current) — antlegion-bus/
npm install
npm run dev:v2          # tsx src/v2/index.ts → http://localhost:28090
npm run build && npm run start:v2
npm run bench:v2        # throughput benchmark (redis-benchmark analog)
node dist/v2/bin.js <cmd>   # alctl CLI (publish/read/claim/resolve/state/info); needs build + a running bus
npx tsx examples/swarm-v2.ts    # multi-agent validation swarms (also scenario-{resilience,consensus,pipeline})

# tests (244 total: v1 in test/, v2 in test/v2/)
npm test                              # vitest run (everything)
npm run test:v2                       # only v2 suites
npx vitest run test/v2/fold-lifecycle.test.ts   # single file
npx vitest run -t "exactly-once"                # by name

# v1 (legacy) — antlegion-bus/
npm run dev / npm start               # v1 bus on :28080
# antlegion-mcp/ : npm run build; wire dist/index.js into an MCP client (see QUICKSTART-v1-mcp.md)

# v1 stack
docker compose up -d                  # runs ONLY the v1 bus on :28080
```

There is no lint config. `npx tsc --noEmit` typechecks.

## v2 architecture (current)

```
clients → ClientV2 (SDK, src/v2/client.ts) ─HTTP→ server.ts → BusV2 (src/v2/bus.ts) → JsonlLog (src/v2/log.ts)
          alctl CLI (cli.ts/bin.ts)                                    └ folds (fold.ts) run client-side
```

- **`bus.ts` — stateless trusted core.** Assigns total order (`seq`), verifies the content-hash `id`, stamps a trusted receive time (`recv`) + HMAC `sig`, persists, serves a range. Its only derived indexes (seq counter, `id→seq` dedup) are pure projections of the log. **No per-fact mutable state, no state machine.**
- **`fold.ts` — reader folds (the semantics).** `lifecycle` (claimed/resolved/dead/open), `claimWinner`/`didIWin`, `trust`, `supersededBy`/`isSuperseded`, `causationChain`. Pure functions over the fact stream.
- **`server.ts`** — Hono wire surface: `POST /facts`, `GET /facts` (since/type/author/refs filters), `/facts/head`, `/facts/:id`, `/info` (INFO), `POST /admin/rewrite` (BGREWRITEAOF).
- **`log.ts`** — append-only AOF: `appendfsync` policy (`always|everysec|no`), flush-on-close, compaction that keeps the full `{id,seq,recv,author,refs,sig}` skeleton (only payloads dropped).
- **`client.ts`** — folding SDK over a transport (`localTransport(bus)` for in-process/tests, `httpTransport(url)` for real). Keeps the surface as small as MCP's tools while absorbing append-then-read-back-and-fold.

The **Fact** (v2): `{seq, recv, id, type, author, ts, payload, refs, nonce?, sig}`. `refs` is the only relational mechanism (`parent`, `claim_of`, `resolves`, `release_of`, `vote`, `supersedes`, `subject`, `tombstones`) and always references **fact ids, never agent ids** — that's the structural reason there are no commands.

### v2 things to know
- **Exactly-once is a theorem of total order**, not a lock: the lowest-`seq` live `claim_of:F` wins; every reader computes the same winner.
- **Time-based folds key on `recv` (bus-stamped, trusted), never `ts` (author-stated, advisory).** Claim expiry is **recv-anchored and deterministic**: a claim expires once a later fact's `recv` passes `claim.recv + Δ`; only a trailing claim falls back to wall-clock `now`. This is what lets crash-recovery re-dispatch transfer ownership without un-doing a real resolve (see `PROTOCOL.md` §3.1).
- **Idempotent by `id`**: re-appending identical content returns the existing fact; set a fresh `nonce` for a genuinely new action.
- Hashing reuses v1's `stableJsonStringify` (Python-compatible float rendering) — `src/v2/hash.ts` imports it from `../engine/ContentHasher.ts`.

## v1 architecture (legacy) & its gotchas

v1 is a mutable-state engine: `server/app.ts` wires routes to `engine/BusEngine.ts`, which owns the fact registry, two state machines (`WorkflowStateMachine` ⊥ `EpistemicStateMachine`), filtering/arbitration, flow control, reliability (TEC), and `JSONLStore` persistence. Watch out for:
- **The event/dispatch system is inert over HTTP** — `app.ts` registers no-op callbacks and there is no WebSocket; v1 is poll-only via `GET /facts?since_sequence=N`.
- **`ContentHasher` must match a Python reference byte-for-byte** (the `.0` float rule); changing it has broken tests before.
- **Default `mode` differs by layer** (`createFact` → `exclusive`; the route/MCP default → `broadcast`); internal states `matched`/`processing` are mapped to `published`/`claimed` on the wire.
- The MCP adapter never registers an ant (uses the agent name as `source_ant_id`, tokenless) and persists a cursor to `~/.antlegion/`.

Both generations are ESM (`"type":"module"`); intra-package imports use explicit `.js` extensions from `.ts` sources.

## Reference docs
- `PROTOCOL.md` — v2 protocol (authoritative; §3 folds are normative).
- `PROTOCOL-v1-historical.md` — archived v1 wire format.
- `QUICKSTART.md` — v2 quickstart (server + SDK + alctl). `QUICKSTART-v1-mcp.md` — legacy MCP walkthrough.
- `EVOLUTION.md` — why the project looks like this (v0 runtime → v1 → v2 monist redesign).
- `README.md` — project overview, positioning, repo map, validated guarantees.
