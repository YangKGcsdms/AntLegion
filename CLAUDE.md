🌐 **English** · [简体中文](CLAUDE.zh-CN.md)

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AntLegion is a **fact bus** for autonomous agents: an append-only log of immutable, content-addressed facts that agents coordinate through. The founding axiom is **facts, not commands** — agents publish/read/claim/resolve facts and never address each other; coordination emerges from the fact stream. It is **not** a message queue, orchestrator, or agent runtime, and it is positioned as local/embeddable infrastructure (Redis-shaped), not a public SaaS.

There is **one architecture**, in `antlegion-bus/src/` (flat). One primitive — a fact at a unique position in a single total order; two ops — `append` / `read`. Claim, resolve, trust, supersession, and causation are **reader folds**, not server state. `PROTOCOL.md` is the **authoritative spec**; its §3 fold rules are normative (that is where meaning lives, since the bus is stateless). Keep `PROTOCOL.md` and `src/` in sync. (An earlier v1 — a mutable-state bus + a separate MCP package — was removed; see `docs/EVOLUTION.md` and git history.)

## Commands

Run inside `antlegion-bus/`, not the repo root.

```bash
npm install
npm run dev             # tsx src/index.ts → http://localhost:28090
npm run build && npm run start
npm run mcp             # MCP stdio adapter (after build): node dist/mcp.js
npm run bench           # throughput benchmark (redis-benchmark analog)
node dist/bin.js <cmd>  # alctl CLI (publish/read/tail/claim/resolve/state/trust/causation/info); needs build + a running bus
npx tsx examples/swarm-v2.ts   # multi-agent validation swarms (also scenario-{resilience,consensus,pipeline})

# tests (136)
npm test                                    # vitest run
npx vitest run test/fold-lifecycle.test.ts  # single file
npx vitest run -t "exactly-once"            # by name

# conformance vectors (the §4 interop contract)
npx tsx conformance/generate.ts   # regenerate vectors.json (only on an intentional protocol change — a changed hash is wire-breaking)
python3 conformance/verify.py     # independent cross-language check: reproduce every committed hash byte-for-byte
```

No lint config. `npx tsc --noEmit` typechecks.

## Architecture

```
clients → ClientV2 (SDK, src/client.ts) ─HTTP→ server.ts → BusV2 (src/bus.ts) → JsonlLog (src/log.ts)
          alctl CLI (cli.ts/bin.ts)                              └ folds (fold.ts) run client-side
          MCP adapter (mcp.ts, over stdio)
```

- **`bus.ts` — stateless trusted core.** Assigns total order (`seq`), verifies the content-hash `id`, stamps a trusted receive time (`recv`) + HMAC `sig`, persists, serves a range. Its only derived indexes (seq counter, `id→seq` dedup) are pure projections of the log. **No per-fact mutable state, no state machine.**
- **`fold.ts` — reader folds (the semantics).** `lifecycle` (claimed/resolved/dead/open), `claimWinner`/`didIWin`, `trust`, `supersededBy`/`isSuperseded`, `causationChain`. Pure functions over the fact stream.
- **`server.ts`** — Hono wire surface: `POST /facts`, `GET /facts` (since/type/author/refs; returns `X-Max-Seq` for cursor advance), `/facts/head`, `/facts/:id`, `/info` (INFO), `POST /admin/rewrite` (BGREWRITEAOF), `/health`.
- **`log.ts`** — append-only AOF: `appendfsync` policy (`always|everysec|no`), flush-on-close, compaction that keeps the full `{id,seq,recv,author,refs,sig}` skeleton (only payloads dropped).
- **`client.ts`** — folding SDK over a transport (`localTransport(bus)` for in-process/tests, `httpTransport(url)` for real). `mcp.ts` wraps this same client as an MCP stdio server, so fold logic is written once.
- **`canonical.ts`** — self-contained `stableJsonStringify` (Python-compatible float rendering, used by `hash.ts`) + `globMatch`.

The **Fact**: `{seq, recv, id, type, author, ts, payload, refs, nonce?, sig}`. `refs` is the only relational mechanism (`parent`, `claim_of`, `resolves`, `release_of`, `vote`, `supersedes`, `subject`, `tombstones`) and always references **fact ids, never agent ids** — the structural reason there are no commands.

### Things to know
- **Exactly-once is a theorem of total order**, not a lock: the lowest-`seq` live `claim_of:F` wins; every reader computes the same winner.
- **Time-based folds key on `recv` (bus-stamped, trusted), never `ts` (author-stated, advisory).** Claim expiry is **recv-anchored and deterministic**: a claim expires once a later fact's `recv` passes `claim.recv + Δ`; only a trailing claim falls back to wall-clock `now`. This lets crash-recovery re-dispatch transfer ownership without un-doing a real resolve (`PROTOCOL.md` §3.1).
- **Idempotent by `id`**: re-appending identical content returns the existing fact; set a fresh `nonce` for a genuinely new action.
- **Server config is env-driven** (`config.ts`, the `redis.conf` analog): `PORT` (28090), `ANTLEGION_DATA_DIR` (`.data-v2`), `ANTLEGION_FSYNC` (`always|everysec|no`, default `everysec`), `ANTLEGION_BUS_SECRET`. Set a **stable** `ANTLEGION_BUS_SECRET` — unset, the bus mints a fresh HMAC key each boot and `sig`s written before a restart can no longer be verified.
- ESM (`"type":"module"`); intra-package imports use explicit `.js` extensions from `.ts` sources.
- **Spec safety rules are enforced, not just documented (§4/§5).** `append` rejects causation depth > `maxDepth` (`ANTLEGION_MAX_DEPTH`, default 64); parent *cycles* need no check — content addressing makes them unconstructible. The bus verifies every fact's `sig` on recovery when the secret is stable and surfaces `sig_failures` via INFO (`hash.ts:verifySig`, constant-time; HMAC is symmetric so only the bus / a secret-sharing replica can verify, never an HTTP client).
- **`conformance/vectors.json` is the §4 interop contract** (not prose): the TS suite (`test/conformance.test.ts`) and an independent Python verifier (`conformance/verify.py`) both reproduce its hashes + fold outputs. Regenerate only on an intentional protocol change and review the diff — a changed hash is wire-breaking.

## Reference docs
- `PROTOCOL.md` — the protocol (authoritative; §3 folds are normative). `PROTOCOL.zh-CN.md` — Chinese reader's guide.
- `docs/QUICKSTART.md` — 60-second quickstart (server + SDK + alctl + MCP).
- `docs/EVOLUTION.md` — why the project looks like this (v0 runtime → v1 → v2 monist redesign, and why v1 was removed).
- `README.md` — overview, positioning, repo map, validated guarantees. Every doc has a `.zh-CN.md` companion.
