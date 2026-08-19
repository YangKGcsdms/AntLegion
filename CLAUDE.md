🌐 **English** · [简体中文](CLAUDE.zh-CN.md)

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AntLegion is a **shared world-state log for AI agents that share nothing else** (different processes / machines / vendors): an append-only, totally-ordered log of immutable, content-addressed facts. Agents deposit what they observed; every agent folds the same log into the same world — what is X right now (`subject` registers), how it came to be / what it led to (causal trail), whether to trust it, and who owns it. The founding axiom is **facts, not commands** — `refs` name fact ids, never agent ids, so nothing on the log can be addressed to anyone. Ownership / exactly-once claiming is a *corollary* of sharing a world (lowest-seq claim wins), not the purpose. It is **not** a message queue, orchestrator, workflow engine, or multi-agent collaboration framework — "agents doing a task together" is workflow territory and lives in clients (the `ant` dev-chain is one such example), never in the positioning. Local/embeddable infrastructure (Redis-shaped), not a public SaaS. Brand metaphor: **ants reading pheromone on the ground** (stigmergy) — never an army/fleet of workers; avoid fleet/swarm/spawn-as-workforce wording.

Two published packages, no root `package.json` and **no npm workspace** — each is installed and tested on its own:

| dir | package | what it is |
|---|---|---|
| `antlegion-bus/` | `@antlegion/bus` | the bus, folding SDK, `alctl` CLI, conformance vectors |
| `ant/` | `@antlegion/ant` | resident agents (DCUs) that live *on* a log: mirror → fold → act runtime, colony daemon, boards; ships a dev-chain as a workflow client example |
| `dsh-antlegion/` | `@antlegion/dsh` | DeepSeek Harness as a resident agent on the log (perception = Node patrol over the stream, decisions = LLM turns) |
| `antlegion-alias/` | `antlegion` | 20-line alias so `npx antlegion` boots the bus |

`ant` depends on the **published** `@antlegion/bus` (`^0.4.x`), not on `../antlegion-bus`. A local bus change is invisible to `ant` until it is published — or until you `npm link` it deliberately. When bumping the bus, `ant/package-lock.json` must be re-synced or CI's `ant` job fails.

`PROTOCOL.md` is the **authoritative spec**; its §3 fold rules are normative (that is where meaning lives, since the bus is stateless). Keep `PROTOCOL.md` and `antlegion-bus/src/` in sync. (An earlier v1 — a mutable-state bus + a separate MCP package — was removed; see `docs/EVOLUTION.md` and git history.)

## Commands

Run inside a package dir, never the repo root.

```bash
# ── antlegion-bus/ ──
npm install
npm run dev             # tsx src/index.ts → http://localhost:28090
npm run build && npm run start
npm run bench           # throughput benchmark (redis-benchmark analog)
node dist/bin.js <cmd>  # alctl CLI; needs build + a running bus
npx tsx examples/swarm-v2.ts   # validation swarms (also scenario-{resilience,consensus,pipeline}, demo-killer)

npm test                                    # vitest run
npx vitest run test/fold-lifecycle.test.ts  # single file
npx vitest run -t "exactly-once"            # by name

# conformance vectors (the §4 interop contract)
npx tsx conformance/generate.ts   # regenerate vectors.json (only on an intentional protocol change)
python3 conformance/verify.py     # independent cross-language check: reproduce every committed hash byte-for-byte

# ── ant/ ──  (npm install first; tests fail with "Cannot find package '@antlegion/bus/fold'" without it)
npm test                 # vitest run
npm run chain            # tsx src/main.ts chain — the dev-chain DCUs, a workflow client example (needs a bus on :28090)
npm run board            # supervision board → http://localhost:28091/devchain.html
npm run req -- new "名称" -s slug         # publish a req.registered to drive the chain
ANT_WORKER=simulated npx tsx src/main.ts mvp --reqs 25   # unattended throughput run, no API key
./scripts/up.sh          # idempotent: bus + ingestor + dev-chain DCUs + board;  ./scripts/down.sh stops all
```

No lint config. `npx tsc --noEmit` typechecks (both packages; it is what CI runs). CI (`.github/workflows/ci.yml`) runs three jobs: `bus` (typecheck + vitest + `conformance/verify.py`), `ant` (typecheck + vitest), and `vectors-guard`.

**`conformance/vectors.json` is wire-breaking to change.** `vectors-guard` fails any PR that touches it unless a commit message in the PR contains the literal marker `[protocol-change]`. Regenerate only on a deliberate protocol change, and review the hash diff.

## Architecture

```
ant resident DCUs (ant/src/runtime.ts) ─┐
alctl CLI (bus src/cli.ts, bin.ts)  ─┼─HTTP→ server.ts → BusV2 (bus.ts) → JsonlLog (log.ts)
your code → ClientV2 (client.ts)    ─┘                         └ folds (fold.ts) run client-side
```

### `antlegion-bus/src/` (flat)

- **`bus.ts` — stateless trusted core.** Assigns total order (`seq`), verifies the content-hash `id`, stamps a trusted receive time (`recv`) + HMAC `sig`, persists, serves a range. Its only derived indexes (seq counter, `id→seq` dedup) are pure projections of the log. **No per-fact mutable state, no state machine.**
- **`fold.ts` — reader folds (the semantics).** `current`/`history` (the §3.3 subject register — "what is X right now"), `supersededBy`/`isSuperseded`, `causationChain`/`descendants` (§3.4 trail, both directions), `lifecycle` (claimed/resolved/dead/open), `claimWinner`/`didIWin`, `trust`, plus the optional conventions of §3.5–§3.6: `colony`/`SYS_REGISTRY` (who is on the board), `orphanReport` (fact types nobody listens for), `contextGaps` (`context.requested`/`context.provided`). Pure functions over the fact stream.
- **`server.ts`** — Hono wire surface: `POST /facts`, `GET /facts` (since/type/author/refs; returns `X-Max-Seq` for cursor advance), `/facts/head`, `/facts/:id`, `/info` (INFO), `POST /admin/rewrite` (BGREWRITEAOF), `/health`, plus the static `/dashboard` + `/console`.
- **`log.ts`** — append-only AOF: `appendfsync` policy (`always|everysec|no`), flush-on-close, compaction that keeps the full `{id,seq,recv,author,refs,sig}` skeleton (only payloads dropped).
- **`client.ts`** — folding SDK over a transport (`localTransport(bus)` for in-process/tests, `httpTransport(url)` for real). `cli.ts` drives this same client, so fold logic is written once.
- **`daemon.ts`** — `antlegion start|stop|status`, redis-server style; pidfile + log next to the journal.
- **`canonical.ts`** — self-contained `stableJsonStringify` (Python-compatible float rendering, used by `hash.ts`) + `globMatch`.

The **Fact**: `{seq, recv, id, type, author, ts, payload, refs, nonce?, sig}`. `refs` is the only relational mechanism (`parent`, `claim_of`, `resolves`, `release_of`, `vote`, `supersedes`, `subject`, `tombstones`) and always references **fact ids, never agent ids** — the structural reason there are no commands.

### `ant/src/` — DCUs (Domain Control Units)

A DCU is a thin deterministic supervisor loop over the bus, named after a CAN-bus control unit: it listens for what it cares about and acts on its one trigger predicate. Nothing here extends the protocol — every DCU is an ordinary bus client.

```
poll(since cursor) → rebuild shared fold → evaluate trigger → act → advance
```

- **`runtime.ts`** — the loop primitive (`runDCU`/`DCUSpec`/`DCUContext`). Keeps a mirrored stream, re-folds on every batch, resets + re-runs `init` when the bus restarts from an empty journal (`head < cursor`). Emits `sys.heartbeat` carrying a per-boot instance token. One process-level SIGINT/SIGTERM fan-out for all resident DCUs, not per-DCU.
- **`folds/`** — `devchain.ts` (stage registry + evidence rules + chain fold), `chain.ts` (requirement board), `watchdog.ts` (starvation/escalation, pure), `identity.ts` (two live instance tokens under one author ⇒ `sys.identity.conflict`).
- **`dcus/`** — the six dev-chain units (`devchain-dcus.ts` = 4 stage DCUs + adjudicator; `watchdog-dcu.ts`), the read-only workspace `ingestor-req.ts`, `scheduler-dcu.ts` (cron beats *published as facts*), `worker-spawn.ts` (headless-agent act), `workers-llm.ts` (pi-ai → DeepSeek acts), `gate-approver.ts`.
- **`main.ts`** — the `ant` CLI. Its `HELP` string is the current command list (`chain`/`ingestor`/`board`/`req new`/`mvp`/`init`/`start [--daemon]`/`stop`/`status`/`logs`/`launchd`); `ant/README.md` predates the residency commands and still says `init`/`start` "land in 0.2".
- **`daemon.ts`** — colony residency: detached `ant start`, pid/log/prompts/`memory/` under `./.ant/`, launchd plist for macOS boot.
- **Config** is `./ant.config.json` in the colony root (`config.ts`): `busUrl`, `watchRoots`, `worker` (`llm|simulated|spawn`), `identity` (colony name + origin/payload claim scoping), `spawn`, `schedules`, `heartbeatSec`. Env wins over file: `ANTLEGION_BUS_URL`, `ANT_WORKER`, `ANT_LLM_MODEL`, `ANT_LLM_BASE_URL`, `ANT_AUTO_GATE`, `ANT_CLAIM_DELTA`, `BOARD_PORT`, `DEEPSEEK_API_KEY`.

**Evidence shapes are the point** (`做完了 ≠ 验证过了`): resolving is not a declaration, it is submitting evidence. The adjudicator validates each artifact's payload against the shape its producer registered via `sys.registry` and publishes `evidence.accepted`/`evidence.rejected`; a rejected artifact halts that stage. Downstream stages fold on the verdict, never on the raw artifact.

### Things to know
- **Exactly-once is a theorem of total order**, not a lock: the lowest-`seq` live `claim_of:F` wins; every reader computes the same winner.
- **Time-based folds key on `recv` (bus-stamped, trusted), never `ts` (author-stated, advisory).** Claim expiry is **recv-anchored and deterministic**: a claim expires once a later fact's `recv` passes `claim.recv + Δ`; only a trailing claim falls back to wall-clock `now`. This lets crash-recovery re-dispatch transfer ownership without un-doing a real resolve (`PROTOCOL.md` §3.1).
- **Idempotent by `id`**: re-appending identical content returns the existing fact; set a fresh `nonce` for a genuinely new action. Several subsystems lean on this deliberately — `sys.registry` facts publish with `ts:0` + a stable nonce so restart-registration dedups; scheduler fires use `sched:{colony}:{name}:{slot}` so a restart can never double-fire; `req new` and the ingestor's backfill plan byte-identical facts for the same dir.
- **A long act holds its claim by overlapping re-claim, never release** (`worker-spawn.ts`): re-claim the same input with a fresh nonce every Δ/3; the earlier claim expires at `recv+Δ` and the same author's later claim is then the lowest live seq. Ownership continues with zero race and zero protocol change; if the child dies, renewal stops and the claim lapses naturally.
- **The bus cannot forbid two processes sharing an author — a fold can see it.** `detectIdentityConflicts` folds heartbeats; two live instance tokens under one author is a double-start (检测代替禁止). One identity = one process.
- **Server config is env-driven** (`antlegion-bus/src/config.ts`, the `redis.conf` analog): `PORT` (28090), `HOST` (127.0.0.1), `ANTLEGION_DATA_DIR` (`.data-v2`), `ANTLEGION_FSYNC` (`always|everysec|no`, default `everysec`), `ANTLEGION_BUS_SECRET`, `ANTLEGION_MAX_DEPTH` (64). Set a **stable** `ANTLEGION_BUS_SECRET` — unset, the bus mints a fresh HMAC key each boot and `sig`s written before a restart can no longer be verified.
- ESM (`"type":"module"`); intra-package imports use explicit `.js` extensions from `.ts` sources.
- **Spec safety rules are enforced, not just documented (§4/§5).** `append` rejects causation depth > `maxDepth`; parent *cycles* need no check — content addressing makes them unconstructible. The bus verifies every fact's `sig` on recovery when the secret is stable and surfaces `sig_failures` via INFO (`hash.ts:verifySig`, constant-time; HMAC is symmetric so only the bus / a secret-sharing replica can verify, never an HTTP client).
- Spawned agent children get a **whitelisted env only**; `ANTLEGION_BUS_SECRET` and `LARK_*` are blocked even if explicitly listed in `spawn.envPass`.
- Docs are bilingual by convention: **every `X.md` has an `X.zh-CN.md` companion** — update both, or neither.

## Reference docs
- `PROTOCOL.md` — the protocol (authoritative; §3 folds are normative). `PROTOCOL.zh-CN.md` — Chinese reader's guide.
- `docs/QUICKSTART.md` · `docs/AGENT-CLI.md` (how agents drive the bus via `alctl`) · `docs/FACT-MODEL.md` · `docs/EVOLUTION.md` (v0 runtime → v1 → v2 monist redesign, and why v1 was removed) · `docs/DOCKER-VERIFY.md` · `docs/proposals/` (design docs under review).
- `README.md` — overview, positioning, repo map, validated guarantees. `ant/README.md` — the DCU model, dev-chain table, supervision board.
- `research/` — first-party measurements the READMEs cite (contention/double-execution, forged-evidence interception). `deploy/mvp/`, `toys/` — containerized multi-agent runs.
