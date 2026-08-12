<div align="center">

🌐 **English** · [简体中文](README.zh-CN.md)

# AntLegion

**A fact bus for autonomous agents** — local, embeddable infrastructure where agents coordinate by sharing immutable facts, never by sending each other commands.

[![npm](https://img.shields.io/npm/v/%40antlegion%2Fbus?style=flat-square&label=%40antlegion%2Fbus&color=CB3837&logo=npm)](https://www.npmjs.com/package/@antlegion/bus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](antlegion-bus/tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-147%20passing-brightgreen?style=flat-square)](antlegion-bus/test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)]()

</div>

---

Think of it as **Redis for multi-agent coordination**: one persistent process, one append-only log of immutable facts, many agents reading and reacting — coordination emerges from the structure of facts, not from an orchestrator handing out instructions.

## Table of Contents

- [The core idea](#the-core-idea)
- [Key properties](#key-properties)
- [Quickstart](#quickstart)
- [The fact](#the-fact)
- [Coordinate from code](#coordinate-from-code)
- [Connect via MCP](#connect-via-mcp)
- [Validated guarantees](#validated-guarantees)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Status](#status)
- [Contributing](#contributing)
- [License](#license)

---

## The core idea

**Facts, not commands.**

`"item 7 needs processing"` is a fact and belongs on the bus.  
`"worker-3, process item 7"` is a command — it has no place here.

No agent ever addresses another. Agents publish observations about the world, read the shared log at their own pace, and react. Who works on what, in what order, with what confidence — all of it emerges from the structure of the fact stream.

The bus enforces exactly one thing: **total order**. From total order, exactly-once assignment falls out as a mathematical theorem: the claim with the lowest sequence number wins, and every reader computes the same winner from the same immutable stream.

This is not aspirational. It is [validated by runnable multi-agent swarms](#validated-guarantees).

## Key properties

| Property | How it works |
|---|---|
| **Immutable facts** | Content-addressed by `sha256(canonical(record))` — identical content is deduplicated automatically; every fact has a stable, forgery-proof identity |
| **Total order** | The bus assigns a strictly increasing `seq`; this is its only authority over clients |
| **Exactly-once coordination** | The lowest-`seq` claim on any fact wins — a theorem of total order, not a lock or a special-purpose endpoint |
| **Trusted time** | Bus-stamped `recv` (not author-stated `ts`) anchors all time-based folds deterministically; a crashed agent's stale claim cannot block recovery |
| **Stateless bus** | Claim, resolve, trust, supersession, causation are pure fold functions over the stream — the bus holds no per-fact mutable state |
| **Durable** | Append-only journal (`facts-v2.jsonl`) with configurable `appendfsync` policy; crash recovery replays the log — no state machine to rebuild |
| **Verifiable** | Every fact is HMAC-signed by the bus; signature verified on recovery; interop guaranteed by a [cross-language conformance vector set](antlegion-bus/conformance/vectors.json) |

## Quickstart

**Requires Node.js ≥ 20**

The main path is two packages and four commands: boot a bus, put a DCU fleet on it, feed it a requirement, and watch it run autonomously.

**1. Boot a bus** (five seconds, zero config):

```bash
npx @antlegion/bus
# [antlegion-v2] append-only fact bus on http://localhost:28090 (fsync=everysec)
```

**2. Start the DCU fleet** ([`@antlegion/ant`](https://www.npmjs.com/package/@antlegion/ant) — the dev-chain: 4 stage DCUs + adjudicator + watchdog):

```bash
npx @antlegion/ant chain
```

**3. Feed it a requirement and watch the chain run**:

```bash
npx @antlegion/ant req new "pilot requirement" -s pilot
npx @antlegion/ant board      # supervision board → http://localhost:28091/devchain.html
```

Within ~2s `dcu-plan` claims the requirement (exactly-once, lowest seq wins), produces `plan.ready`, the adjudicator checks its evidence shape, and the chain parks at the H1 human gate — approve it on the board and dev → unittest → e2e run themselves to ✔ CHAIN DONE. No orchestrator, no unit addressing another; all coordination is reader folds over the fact stream.

See [`ant/`](ant) for the DCU runtime, dev-chain, evidence adjudication, and boards. Additionally, any MCP-capable agent (Claude Code, Cursor, …) can connect to the bus for publish/claim/resolve tools — see [Connect via MCP](#connect-via-mcp).

**From source** (development):

```bash
git clone https://github.com/YangKGcsdms/antlegion-platform.git
cd antlegion-platform/antlegion-bus
npm install && npm run dev
```

**Or with Docker** (build from the repo root):

```bash
docker build -t antlegion .
docker run -p 28090:28090 -e ANTLEGION_BUS_SECRET=your-stable-secret antlegion
```

### Drive it from the terminal (`alctl` — the redis-cli analog)

`npm i -g @antlegion/bus` installs three commands: `antlegion` (the server), `alctl`, and `antlegion-mcp`. Every `alctl` command prints machine-readable JSON on stdout; human errors go to stderr with a non-zero exit code.

```bash
alctl publish task.build '{"target":"todo-app"}' --author alice
# → {"id":"b3f1…","seq":1,"deduped":false}

alctl claim <id> --author bob
# → {"won":false,"winner":"alice"}        (exit 1 — you lost the claim)

alctl state <id>
# → {"state":"claimed","owner":"alice"}

alctl resolve <id> --author alice   # only the claim winner can resolve
# → {"state":"resolved","owner":"alice"}
# a non-winner's resolve fails loudly and exits non-zero:
#   error: resolve ignored — fact <id> is owned by 'alice' (you are 'bob')

alctl tail            # prints the stream once and exits
alctl tail --follow   # live tail: polls ?since= until Ctrl-C

alctl info            # full INFO payload
# → {"protocol":"2.0","head_seq":1,"facts":3,"fsync":"everysec","sig_failures":0,"secret_stable":true,…}
```

*(without a global install: `npx -y -p @antlegion/bus alctl <cmd>`)*

`--author <name>` is a global flag that works on every command that writes facts. Identity resolution order:

| Setting | Purpose |
|---|---|
| `--author <name>` | Per-command identity (wins over everything) |
| `ANTLEGION_AUTHOR` | CLI identity for the whole shell session |
| *(default)* | `<os-username>@<hostname>` — stable across CLI invocations, so `claim` then `resolve` just works |
| `ANTLEGION_BUS_URL` | Where the CLI/SDK finds the bus (default `http://localhost:28090`) |

### Or use the HTTP API directly

```bash
# Append a fact
curl -sX POST http://localhost:28090/facts \
  -H 'content-type: application/json' \
  -d '{"type":"task.build","author":"alice","ts":1748300000,"payload":{"target":"todo-app"}}'
# 201 {"seq":1,"id":"b3f1…","sig":"…","deduped":false}

# Read from a cursor (git-fetch style)
curl -s "http://localhost:28090/facts?since=0&type=task.*"
```

That is the complete wire surface: **one write, one read, two read conveniences.** Everything else — claim, resolve, trust — is facts about facts, folded by the client.

## The fact

One primitive, immutable, content-addressed, placed at a unique position in a single total order:

```jsonc
{
  "seq":    1337,           // bus-assigned position in the total order (trusted)
  "recv":   1748300000.4,   // bus-assigned trusted receive time (unix s) — fold on this, not ts
  "id":     "b3f1…",        // sha256(canonical(record)) — the content address
  "type":   "build.failed", // dotted taxonomy; reserved types begin with "_."
  "author": "claude-code",  // who appended it
  "ts":     1748300000.0,   // author-stated unix seconds (advisory — spoofable, do not fold on this)
  "payload": { "…": "…" },  // arbitrary JSON
  "refs": {                 // the only relational mechanism — all values are fact ids, never agent ids
    "parent":     "<id>",   // causal predecessor
    "claim_of":   "<id>",   // exclusive claim on the target fact
    "resolves":   "<id>",   // target fact is handled; payload may carry the result
    "release_of": "<id>",   // abandon a prior claim
    "vote":       "<id>",   // corroborate / contradict (with payload.verdict)
    "supersedes": "<id>",   // this fact replaces the target
    "subject":    "key",    // group key for latest-wins supersession without naming an id
    "tombstones": "<id>"    // target is deleted / GC'd (distinct from supersedes)
  },
  "nonce": "k7x9",          // optional — makes an otherwise identical re-submission a new fact
  "sig":   "hmac…"          // HMAC-SHA256 over (id|author|type|ts|recv|seq), signed by the bus
}
```

> **`ts` vs `recv`** — `ts` is what the author *claims* the time was (part of the content hash; advisory; spoofable). `recv` is what the bus *witnessed* and signed. Every time-based fold keys on `recv`, never `ts`, so two readers always compute the same result.

Reserved fact types the fold layer interprets:

| Type | Meaning |
|---|---|
| `_.claim` | Exclusive claim on `refs.claim_of`; lowest `seq` wins |
| `_.resolve` | `refs.resolves` fact is done; honored only from the current claim winner |
| `_.release` | Author abandons their claim on `refs.release_of` |
| `_.vote` | Corroborate or contradict `refs.vote` (see `payload.verdict`) |
| `_.tombstone` | `refs.tombstones` fact is deleted/GC'd; distinct from supersession |

## Coordinate from code

The folding client SDK absorbs the append-then-read-back-and-fold work so your code stays clean (`npm i @antlegion/bus`):

```typescript
import { ClientV2, httpTransport } from "@antlegion/bus/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

// Publish a work item
const { id } = await alice.publish("task.build", { target: "todo-app" });

// Both race to claim; lowest seq wins — deterministic, no locks
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]);
const winner = ra.won ? alice : bob;

// Winner resolves, optionally emitting child facts (causation chain)
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);

// Any client folds the same state from the same immutable log
console.log(await alice.state(id)); // { state: "resolved", owner: "alice" }
console.log(await bob.state(id));   // identical — deterministic fold
```

**Peer review (trust folds)**:

```typescript
await bob.observe(factId, "corroborate");
await carol.observe(factId, "contradict");

const verdict = await alice.trustOf(factId);
// "asserted" | "corroborated" | "consensus" | "contested" | "refuted" | "superseded"
```

**Causation chain**:

```typescript
const chain = await alice.causation(buildDoneId);
// [{ type: "task.build", … }, { type: "build.done", … }]  (root → leaf)
```

**Supersession (latest-wins)**:

```typescript
// Emit a newer status for the same subject; the old one is automatically superseded
await alice.publish("deploy.status", { stage: "testing" },
  { refs: { subject: "deploy-run-42" } });

await alice.publish("deploy.status", { stage: "done" },
  { refs: { subject: "deploy-run-42" } });
// Readers see only the second one as current
```

For the in-process embedding path (tests, tight integration):

```typescript
import { BusV2 } from "@antlegion/bus/bus";
import { ClientV2, localTransport } from "@antlegion/bus/client";

const bus = new BusV2({ secret: "my-secret", dataDir: "./data" });
const client = new ClientV2(localTransport(bus), "my-agent");
// No HTTP, no network — same SDK, same folds
```

## Connect via MCP

Any MCP-capable agent — Claude Code, Cursor, Cline, Windsurf, Zed, Goose — can connect to the bus over stdio with a single line:

```bash
claude mcp add antlegion \
  --env ANTLEGION_BUS_URL=http://localhost:28090 \
  --env ANTLEGION_AGENT_NAME=my-agent \
  -- npx -y -p @antlegion/bus antlegion-mcp
```

or via `.mcp.json`:

```json
{
  "mcpServers": {
    "antlegion": {
      "command": "npx",
      "args": ["-y", "-p", "@antlegion/bus", "antlegion-mcp"],
      "env": {
        "ANTLEGION_BUS_URL": "http://localhost:28090",
        "ANTLEGION_AGENT_NAME": "my-agent"
      }
    }
  }
}
```

`ANTLEGION_AGENT_NAME` defaults to `<os-username>@<hostname>`; the resolved
identity is printed to stderr at startup. `ANTLEGION_DATA_DIR` and
`ANTLEGION_BUS_SECRET` (see [Configuration](#configuration)) configure the bus
server itself.

**Seven tools** are exposed: `antlegion_publish`, `antlegion_query`, `antlegion_claim`, `antlegion_resolve`, `antlegion_observe`, `antlegion_causation`, `antlegion_state`.

**One resource**: `antlegion://facts/recent` — the 20 most recent facts, as JSON.

The MCP adapter uses the same `ClientV2` fold SDK as the HTTP client — coordination semantics are implemented once, not per-adapter.

## Validated guarantees

The founding premise is exercised by four runnable swarms in [`antlegion-bus/examples/`](antlegion-bus/examples). Each boots a real server, spawns ~20 autonomous agents, and asserts a concrete, measurable pass gate:

| Swarm | What it proves | Pass gate |
|---|---|---|
| [`swarm-v2`](antlegion-bus/examples/swarm-v2.ts) | 50-item fan-out/in across 16 workers with 460 competing claims — **exactly-once**, zero agent-to-agent addressing | `dupes=0  missing=0` |
| [`scenario-resilience`](antlegion-bus/examples/scenario-resilience.ts) | Agents crash mid-work; **claim-timeout re-dispatch** transfers ownership; exactly-once survives | no stuck items |
| [`scenario-consensus`](antlegion-bus/examples/scenario-consensus.ts) | Peer review converges; the decider acts **only on consensus**, never on refuted facts | decider never acts on refuted |
| [`scenario-pipeline`](antlegion-bus/examples/scenario-pipeline.ts) | Causal `build→test→deploy` with latest-wins **supersession**; all monitors agree on the single fresh status | all monitors agree |

```bash
npx tsx examples/swarm-v2.ts
npx tsx examples/scenario-resilience.ts
npx tsx examples/scenario-consensus.ts
npx tsx examples/scenario-pipeline.ts
```

Each example self-boots its own bus on an ephemeral port — no bus needed beforehand.

### The killer demo

[`demo-killer`](antlegion-bus/examples/demo-killer.ts) compresses the whole pitch into ~13 seconds, in three acts: **(1)** 8 agent processes from 4 "frameworks" race for 400 tasks — duplicates: 0, decided by total order, not a lock; **(2)** a real process is `SIGKILL`ed mid-work and its orphaned claims expire on the trusted bus clock and are re-won by survivors — no orchestrator was notified, none exists; **(3)** the bus itself is killed and restarted from the journal — `head_seq`, stream hash, and every task's owner/state come back byte-identical.

```bash
npx tsx examples/demo-killer.ts
```

Pair it with the zero-dependency live dashboard in [`demo/`](antlegion-bus/demo) — a task grid, per-agent cards, and a duplicate counter updating in real time in your browser, with automatic replay-verification when the bus restarts. See [`demo/README.md`](antlegion-bus/demo/README.md).

## Configuration

| Environment variable | Default | Notes |
|---|---|---|
| `PORT` | `28090` | HTTP listen port |
| `ANTLEGION_DATA_DIR` | `.data-v2` | Directory for the journal file (`facts-v2.jsonl`) |
| `ANTLEGION_FSYNC` | `everysec` | `always` (max durability) · `everysec` (≤1s loss) · `no` (OS decides) — mirrors Redis `appendfsync` |
| `ANTLEGION_BUS_SECRET` | *(random each boot)* | HMAC signing secret. **Always set a stable value in production** — without it, signatures written before a restart cannot be verified |
| `ANTLEGION_MAX_DEPTH` | `64` | Maximum causation chain depth (§5 safety cap; cycles are structurally impossible under content addressing) |

```bash
# Production-style invocation
ANTLEGION_BUS_SECRET=a-stable-32-char-secret \
ANTLEGION_DATA_DIR=/var/lib/antlegion \
ANTLEGION_FSYNC=always \
node dist/index.js
```

## Architecture

```
 Clients
 ┌──────────────────┐  ┌───────────────┐  ┌────────────────────┐
 │  ClientV2 (SDK)  │  │  alctl CLI    │  │  MCP stdio adapter │
 │  client.ts       │  │  cli.ts       │  │  mcp.ts            │
 │  - publish       │  │  - publish    │  │  - antlegion_*     │
 │  - claim/resolve │  │  - claim      │  │    tools (7)       │
 │  - trust/state   │  │  - tail/info  │  │                    │
 └────────┬─────────┘  └──────┬────────┘  └─────────┬──────────┘
          │                   │                      │
          └───────────────────┴──────────────────────┘
                              │ HTTP (POST /facts · GET /facts)
                              ▼
 ┌────────────────────────────────────────────────────────────────┐
 │  server.ts  (Hono, thin wire surface)                          │
 │  POST /facts · GET /facts[?since&type&author&refs.*]           │
 │  GET /facts/:id · GET /facts/head · GET /info                  │
 │  POST /admin/rewrite  (BGREWRITEAOF analog)                    │
 │                                                                │
 │  ┌──────────────────────────────────────────────────────────┐  │
 │  │  BusV2  (stateless trusted core)   bus.ts               │  │
 │  │  · assign seq (strictly increasing)                     │  │
 │  │  · verify id == sha256(canonical(record))               │  │
 │  │  · stamp recv + compute HMAC sig                        │  │
 │  │  · dedup by id (idempotent appends)                     │  │
 │  │  · enforce causation depth cap  (§5)                    │  │
 │  │  · verify sig on log recovery   (§4)                    │  │
 │  └────────────────────────┬─────────────────────────────────┘  │
 │                           │                                    │
 │  ┌────────────────────────▼─────────────────────────────────┐  │
 │  │  JsonlLog  (append-only file journal)   log.ts           │  │
 │  │  · single append-mode fd (open once, not per-write)     │  │
 │  │  · appendfsync: always | everysec | no                  │  │
 │  │  · compaction: temp-file + atomic rename                │  │
 │  └──────────────────────────────────────────────────────────┘  │
 └────────────────────────────────────────────────────────────────┘

 Reader folds  (fold.ts — pure functions, run in the client, not the server)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  lifecycle(stream, F)       →  open | claimed | resolved | dead          │
 │  claimWinner(stream, F)     →  string | null                             │
 │  trust(stream, F, quorum)   →  asserted | corroborated | consensus | …  │
 │  supersededBy(stream, F)    →  id | null                                 │
 │  causationChain(stream, F)  →  Fact[]   (root → leaf)                   │
 └──────────────────────────────────────────────────────────────────────────┘
```

**The key design choice**: meaning lives in the folds, not in the bus. Two clients folding the same stream always agree, regardless of when they read — the bus only orders and preserves.

## Repository layout

```
antlegion-platform/
├── README.md               ← you are here (每份文档都有 .zh-CN.md 中文版)
├── PROTOCOL.md             ← wire protocol spec — §3 fold rules are normative
├── Dockerfile              ← docker build . && docker run -p 28090:28090 …
├── ant/                    ← @antlegion/ant — DCU runtime + dev-chain fleet + boards
├── docs/
│   ├── QUICKSTART.md       ← step-by-step: server + SDK + CLI + MCP
│   └── EVOLUTION.md        ← v0 → v1 → v2: what was tried and why it changed
└── antlegion-bus/
    ├── src/
    │   ├── bus.ts          ← stateless trusted core
    │   ├── fold.ts         ← reader folds (the semantics layer)
    │   ├── client.ts       ← ClientV2 folding SDK
    │   ├── server.ts       ← Hono wire surface
    │   ├── log.ts          ← AOF journal
    │   ├── mcp.ts          ← MCP stdio adapter
    │   ├── cli.ts / bin.ts ← alctl CLI
    │   ├── hash.ts         ← sha256 content address + HMAC + verifySig
    │   ├── canonical.ts    ← stableJsonStringify (Python-float compatible)
    │   ├── types.ts        ← Fact, FactInput, Refs, RESERVED types
    │   └── config.ts       ← env-driven config (redis.conf analog)
    ├── conformance/
    │   ├── vectors.json    ← §4 interop contract: 7 hash + 24 fold vectors
    │   ├── generate.ts     ← derive vectors from the reference implementation
    │   └── verify.py       ← independent Python §4 reimplementation (cross-language proof)
    ├── examples/
    │   ├── swarm-v2.ts              ← 21-agent exactly-once fan-out
    │   ├── scenario-resilience.ts  ← crash + re-dispatch
    │   ├── scenario-consensus.ts   ← peer-review trust
    │   └── scenario-pipeline.ts    ← causal pipeline + supersession
    └── test/               ← 147 tests (vitest, ~1s)
```

## Status

**Alpha** — the core protocol, reference implementation, and single-node operational story are solid. Not yet recommended for untrusted public networks.

### Done

- [x] Stateless trusted core: assign order · verify content hash · HMAC-sign · persist · serve a range
- [x] Append-only journal with `appendfsync always|everysec|no` + `BGREWRITEAOF`-style compaction
- [x] Reader fold SDK: `lifecycle`, `trust`, `supersession`, `causation`
- [x] `alctl` CLI — the `redis-cli` analog
- [x] MCP stdio adapter — one-liner connect for any MCP-capable agent
- [x] §5 causation-depth enforcement at append time
- [x] §4 signature verification on log recovery, `sig_failures` surfaced via `/info`
- [x] Cross-language conformance vectors — hash + fold interop proof with independent Python verifier
- [x] Four multi-agent validation swarms (exactly-once · resilience · consensus · pipeline)
- [x] Docker image · ~160k appends/s in-process benchmark · 147 tests

### Roadmap

- [x] Published npm package — [`@antlegion/bus`](https://www.npmjs.com/package/@antlegion/bus) (`npx @antlegion/bus` boots a bus)
- [x] [`@antlegion/ant`](https://www.npmjs.com/package/@antlegion/ant) — DCU runtime + dev-chain fleet + supervision board (`npx @antlegion/ant chain`)
- [ ] `ant init` / `ant start` — guided setup + resident daemon (0.2)
- [ ] Real workers: the act step spawns an LLM session (coordination stays in deterministic code; the LLM only does the work)
- [ ] Multi-language client SDKs — Go, Python, Rust (conformance vectors are ready to test against)
- [ ] Auth + per-author rate limiting for public-facing deployments
- [ ] Replication / HA (protocol design: single-writer + failover; see PROTOCOL.md §7)
- [ ] CI integration for the cross-language Python verifier

## Contributing

Contributions are welcome. Please keep these in mind:

**Protocol changes are wire-breaking.** Any change to the fact shape, the `id` computation (§4), or the §3 fold rules must be reflected in three places simultaneously: `PROTOCOL.md`, `conformance/vectors.json` (regenerate with `npx tsx conformance/generate.ts`), and the cross-language verifier. Run `python3 conformance/verify.py` to confirm nothing diverged.

**Before submitting a PR:**

```bash
npm test                      # 147 tests, ~1s
npx tsc --noEmit              # type check
python3 conformance/verify.py # cross-language hash proof
npx tsx examples/swarm-v2.ts  # sanity-run the swarms (optional but appreciated)
```

See [`EVOLUTION.md`](docs/EVOLUTION.md) for design rationale and what was tried before — it'll save you from re-inventing discarded approaches.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
  <sub>AntLegion Protocol v2.0 · Designed by Carter.Yang · Derived from first principles, 2026.</sub>
</div>
