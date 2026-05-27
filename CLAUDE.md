# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AntLegion is a **fact bus** for autonomous agents: a passive, append-only state store of immutable, content-hashed facts with a causation chain and a two-axis state model. It is **not** a message queue, orchestrator, or agent runtime. Clients poll; the bus never pushes.

The repo is two independent Node/TypeScript packages:

- **`antlegion-bus/`** — the bus server. Hono HTTP API + in-memory fact registry + append-only JSONL persistence. This is where all protocol logic lives.
- **`antlegion-mcp/`** — a thin MCP (Model Context Protocol) stdio adapter that exposes the bus to any MCP client (Claude Code, Cursor, …) as **6 tools** and **2 resources**, hiding hashing/signing/tokens/ant-identity.

`PROTOCOL.md` is the **authoritative spec**. When changing bus behavior, treat `PROTOCOL.md` and `src/types/protocol.ts` as the source of truth and keep them in sync — the types file is described in-code as "the protocol specification in machine-readable form."

## Commands

All commands run inside the package directory (`antlegion-bus/` or `antlegion-mcp/`), not the repo root.

```bash
# antlegion-bus/
npm run dev            # run server with tsx (no build), reads PORT / ANTLEGION_DATA_DIR / ANTLEGION_BUS_SECRET
npm run build          # tsc → dist/
npm start              # node dist/index.js
npm test               # vitest run (all tests)
npm run test:watch     # vitest watch
npx vitest run test/bus-engine.test.ts          # single test file
npx vitest run -t "claim timeout"               # single test by name

# antlegion-mcp/
npm run build          # tsc → dist/  (must build before wiring into an MCP client)
npm run dev            # tsc --watch

# whole stack
docker compose up -d   # builds + runs only the bus on :28080 (from repo root)
curl http://localhost:28080/health
```

Tests live only in `antlegion-bus/test/` (vitest). `antlegion-mcp` has no test suite. There is no lint config.

## Architecture

### Request flow

```
MCP client → antlegion-mcp (stdio, 6 tools) → HTTP → antlegion-bus
                                                        ├─ server/app.ts   (Hono routes, token auth, fact↔response mapping)
                                                        └─ engine/BusEngine (all lifecycle logic) → persistence/JSONLStore
```

`server/app.ts::createApp()` constructs the `BusEngine` and wires routes; `BusEngine` is the single class that owns the fact registry, ant registry, indexes, signing, and background timers. The engine modules are pure helpers it composes:

- **`WorkflowStateMachine.ts`** — the legal transition table (`created→published→matched→claimed→resolved`, plus `dead`). `transition()` throws on illegal moves unless `force`.
- **`EpistemicStateMachine.ts`** — recomputes the trust axis (`asserted→corroborated→consensus` / `→contested→refuted` / `→superseded`) from accumulated votes. Never driven by explicit transitions.
- **`FilterEngine.ts`** — `evaluateFilter()` (does a fact reach a consumer) and `arbitrate()` (which single consumer wins an exclusive fact, by score→reliability→ant_id).
- **`FlowControl.ts`** — `PublishGate` runs the admission checks in order: causation depth → cycle → behavioral livelock → dedup window → per-ant token-bucket rate limit → global load breaker.
- **`ReliabilityManager.ts`** — CAN-style transmit-error-counter (TEC) per ant; `active`/`degraded`/`isolated` and a derived `reliability_score`.
- **`ContentHasher.ts`** — SHA-256 over the canonical immutable record (see gotcha below).

### Two orthogonal state machines per fact

Every fact carries **`state`** (workflow lifecycle) AND **`epistemic_state`** (trust). They are independent. Workflow is changed by operations (publish/claim/resolve); epistemic is *derived* and recomputed after every corroborate/contradict/supersede. See `PROTOCOL.md §4`.

### Persistence & recovery

`JSONLStore` is an append-only journal (`<dataDir>/facts.jsonl`). Each lifecycle event (publish/claim/resolve/release/supersede/corroborate/contradict/redispatch/causation_repair/purge) is one line, fsync'd. On boot, `BusEngine.recoverFromStore()` replays the log to rebuild in-memory state and restore the sequence counter. Compaction (hourly) keeps only lines for live facts via temp-file + atomic rename. Corrupt lines are skipped silently.

### Background timers

`BusEngine.startBackgroundTasks()` runs: TTL/claim-timeout expiry (10s), heartbeat-timeout (30s), GC (60s), compaction (3600s). `shutdown()` clears them — call it on SIGINT/SIGTERM (see `src/index.ts`).

## Non-obvious things to know

- **Poll-only; the event system is effectively inert in the HTTP path.** `BusEngine` has a full `sendEvent`/`BusEvent` dispatch system, but `app.ts` registers a no-op callback (`() => {}`) for every ant. There is no WebSocket. Clients get new facts solely via `GET /facts?since_sequence=N`. Don't add features that assume push delivery without also adding a transport.

- **ContentHasher must match the Python reference byte-for-byte.** The canonical record uses sorted keys and renders float fields (`created_at`, `confidence`) with a trailing `.0` to mimic Python's `json.dumps`. This parity is fragile and has caused real test breakage — if you touch `ContentHasher.ts`, run `content-hasher.test.ts` and expect to update fixtures deliberately, not blindly. Many engine files carry `Mirrors Python: ...` comments; that Python implementation is the conceptual reference but is **not in this repo**.

- **Default `mode` differs by layer.** `createFact()` defaults `mode: "exclusive"`, but the `POST /facts` route and the MCP adapter default to `broadcast` (most LLM-published facts are observations, not tasks). Check the call site before assuming.

- **The MCP adapter never registers an ant.** It uses `ANTLEGION_AGENT_NAME` (or `<hostname>-<pid>`) directly as `source_ant_id`, with no token. The bus accepts unregistered publishers and just skips reliability tracking for them. The adapter persists its poll cursor to `~/.antlegion/cursor-<agent>.json` so restarts resume incrementally.

- **Internal vs protocol-visible states.** `matched` and `processing` are internal workflow states; `factToResponse()` in `app.ts` maps them back to `published`/`claimed` on the wire. Tests and clients see only the four protocol states.

- **`fact_type` query is a glob.** `GET /facts?fact_type=bug.*` matches by glob (`*`,`?`); a pattern with no glob chars matches exactly. `since_sequence` switches the result to ascending-by-sequence and sets the `X-Antlegion-Max-Sequence` header.

- **ESM + NodeNext.** Both packages are `"type": "module"`; intra-package imports use explicit `.js` extensions even from `.ts` sources. Keep that convention.

- **Admin surface is intentionally minimal.** Only `/admin/storage/{gc,compact,stats}` and `/admin/metrics`. Per-fact and per-ant remediation endpoints were deliberately removed (see comment in `app.ts`); don't reintroduce them without a stated user.

## Reference docs

- `PROTOCOL.md` — wire format, both state machines, REST API, signing, optional extensions, defaults table. Authoritative.
- `QUICKSTART.md` — wiring the MCP server into Claude Code (`~/.claude.json`).
- `EVOLUTION.md` — why the project dropped its old 3,000-line agent runtime in favor of the MCP-only model.
