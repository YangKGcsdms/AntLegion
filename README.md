<div align="center">

🌐 **English** · [简体中文](README.zh-CN.md)

# AntLegion

**Run several AI agents on the same project and they re-do each other's work, lose each other's context, and drift apart.** AntLegion fixes this at the fact level: an append-only **fact bus** where autonomous work units post what happened, claim work exactly-once, and let the workflow emerge — no orchestrator, nobody commands anybody. Local, embeddable infrastructure (think Redis, not SaaS).

![npx @antlegion/bus demo — exactly-once race, crash takeover, byte-identical replay](deploy/media/demo.gif)

It doesn't lock files or serialize your agents — conflicts are eliminated at the division-of-work layer, before two units ever touch the same task. Your existing Claude Code / Cursor sessions can join the same bus as work units too, via the [`alctl` CLI](#connect-your-agents-the-alctl-cli).

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
- [Connect your agents (`alctl` CLI)](#connect-your-agents-the-alctl-cli)
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

This is not aspirational. It is [validated by runnable multi-agent swarms](#validated-guarantees) and [measured under contention](research/s2-experiments-2026-08.md).

## Why this exists

Three accidents happen to every multi-agent setup, and they all have the same root cause — there is no shared, ordered record of what already happened:

1. **Duplicated work.** Two agents pick up the same task because neither can see the other's intent. Here, picking up work *is* a fact (`_.claim`), and the total order makes exactly-once a theorem — measured at **0 double-executions across 100 claim units with 4× replicated workers racing** ([experiment log](research/s2-experiments-2026-08.md)).
2. **Lost context.** What agent A learned never reaches agent B, or reaches it as stale prose. Here every observation is an immutable, content-addressed fact any unit can fold at its own pace.
3. **Workflows held together by prose.** "First plan, then dev, then test" lives in a prompt until someone skips a step. Here the pipeline is causal structure (`refs.parent`), and evidence shapes are enforced by an adjudicator — forged "all green" reports were intercepted at **8/8 with 0 false kills** in our injection test.

These failure modes are well documented in the literature — MAST, the multi-agent failure taxonomy ([arXiv:2503.13657](https://arxiv.org/abs/2503.13657)), catalogs inter-agent misalignment and verification gaps as dominant failure classes. The numbers above, though, are ours: first-party, reproducible with one command each.

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

### What it is — and isn't

Not a message queue (nothing is consumed), not an orchestrator (nobody assigns work), not a workflow engine (the pipeline is folded out of the stream, never stored). Against the other ways people coordinate agents today:

| | shared files / scratchpad | SQLite mailbox | hosted coordination SaaS | platform built-in shared state (Agent-Teams-style) | **AntLegion** |
|---|---|---|---|---|---|
| total order | ✗ | per-table, implicit | opaque | opaque | ✓ the core primitive |
| exactly-once claiming | ✗ (locks, hope) | ✗ (row locks) | vendor-defined | vendor-defined | ✓ theorem of the order |
| causality / audit | ✗ | ✗ | partial | partial | ✓ `refs` + signed log |
| local & embeddable | ✓ | ✓ | ✗ | ✗ | ✓ one process, one file |
| cross-harness | ✓ (barely) | ✓ | agent-framework-specific | single vendor | ✓ HTTP + CLI + SDK, any agent |
| open protocol | — | — | ✗ | ✗ | ✓ [PROTOCOL.md](PROTOCOL.md) + conformance vectors |

### Three mechanisms, one collaboration model

**Persistence lets agents share reality. Claiming lets them divide work. Causation lets workflows emerge.** Everything else in the system is one of these three, read from the same ordered log — persistence is the append-only journal ([§1](PROTOCOL.md)), claiming is the lowest-seq theorem ([§3.1](PROTOCOL.md)), causation is `refs.parent` chains ([§3.4](PROTOCOL.md)).

## Quickstart

**Requires Node.js ≥ 20**

**Fastest possible look** — the three-act demo (exactly-once race → crash takeover → byte-identical replay), zero config, zero API key, ~15 seconds:

```bash
npx @antlegion/bus demo
```

The main path is two packages and four commands: boot a bus, put a DCU fleet on it, feed it a requirement, and watch it run autonomously.

**1. Boot a bus** (five seconds, zero config):

```bash
npx @antlegion/bus
# [antlegion-v2] append-only fact bus on http://localhost:28090 (fsync=everysec)
# [antlegion-v2] dashboard → http://127.0.0.1:28090/dashboard
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

See [`ant/`](ant) for the DCU runtime, dev-chain, evidence adjudication, and boards. Additionally, any agent that can run a shell command (Claude Code, Cursor, …) drives the bus for publish/claim/resolve via the [`alctl` CLI](#connect-your-agents-the-alctl-cli).

**Or all of it in containers, one command** — 1 bus + 3 pi-agent containers (Ubuntu 24.04), 100 LLM-acted cycles, scoreboard at the end:

```bash
cd deploy/mvp
DEEPSEEK_API_KEY=sk-… docker compose up --build --exit-code-from mvp
```

See [`deploy/mvp/`](deploy/mvp) — acts route through DeepSeek via pi-ai; `ANT_WORKER=simulated` runs it without any API key.

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

`npm i -g @antlegion/bus` installs two commands: `antlegion` (the server) and `alctl`. Every `alctl` command prints machine-readable JSON on stdout; human errors go to stderr with a non-zero exit code.

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

## Connect your agents (the `alctl` CLI)

A headless or PI agent — Claude Code, Cursor, Codex CLI, a shell tool, a cron job — drives the bus by shelling out to the **`alctl` CLI**. One interface, every verb mapping to exactly one fold call. See [`docs/AGENT-CLI.md`](docs/AGENT-CLI.md) for the full guide.

```bash
export ANTLEGION_BUS_URL=http://localhost:28090   # default
export ANTLEGION_AUTHOR=my-agent                   # stable agent identity

# read new facts, claim exactly-once, resolve with a child fact
alctl read --type 'task.*' --since "$CURSOR"
alctl claim <id> && alctl resolve <id>
alctl publish task.done '{"result":"ok"}' --parent <id>
```

*(without a global install, prefix each command with `npx -y -p @antlegion/bus`.)*

`ANTLEGION_DATA_DIR` and `ANTLEGION_BUS_SECRET` (see [Configuration](#configuration)) configure the bus server itself. The CLI drives the same `ClientV2` fold SDK as the HTTP client — coordination semantics are implemented once, not per-interface.

### First prompt for an agent

Adoption happens in the prompt, not the install. Paste this as your first message to an agent that can run shell commands:

> Check the antlegion fact bus for open `task.todo` facts (`alctl read --type task.todo`). If one is unclaimed, `alctl claim <id>` before working on it; only proceed if the claim exits 0. When done, `alctl resolve <id>` with a short result. If there are no open tasks, `alctl publish task.todo '{…}'` describing the next thing you plan to do, so other agents can see it.

### Rules snippet for CLAUDE.md / .cursorrules

```markdown
## Multi-agent coordination (AntLegion)
- Before starting any task: `alctl read` the fact bus; if a `task.todo` for it exists and is claimed, pick different work.
- Claim before you work (`alctl claim <id>`); proceed ONLY if it exits 0. Losing a claim is normal — move on.
- When finished, `alctl resolve <id>` with what you produced. Never mark work done in prose only.
- Publish significant observations as facts (`alctl publish`) so other agents can react — don't hoard context.
```

### The two-window experiment (5 minutes)

Open two agent shells with `alctl` on PATH, both pointed at the same bus, then in **window A**:

> Publish a task.todo fact — `alctl publish task.todo '{"title": "write a haiku about total order"}'` — then claim it (`alctl claim <id>`) and start working.

Immediately in **window B**:

> Find the latest task.todo on the bus (`alctl read --type task.todo`) and claim it.

Window B loses: `alctl claim` exits non-zero and reports A as the winner, and B moves on instead of duplicating the work. That's exactly-once with zero locks — decided by which claim landed first in the total order, computed identically by both readers.

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
| `HOST` | `127.0.0.1` | Listen address — the bus trusts its callers (same security model as Redis); set `0.0.0.0` only inside a trust boundary |
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

### Ops cheat sheet

- **Where's my data?** One append-only file: `$ANTLEGION_DATA_DIR/facts-v2.jsonl` (default `.data-v2/`). Back it up by copying it.
- **Start fresh:** stop the bus, delete the data dir. There is no other state anywhere.
- **Ctrl-C is safe:** the journal is flushed on shutdown; recovery replays the log and verifies every signature.
- **Always set a stable `ANTLEGION_BUS_SECRET`:** unset, the bus mints a fresh HMAC key each boot — after a restart, `sig`s written earlier can no longer be verified (they surface as `sig_failures` in `/info`).

### Security model

Same trust boundary as Redis: the bus **trusts its callers**. It binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only inside a boundary you control (a docker network, a VPC). There is no authentication yet ([roadmap](#roadmap)) — do not expose it to untrusted networks.

### Troubleshooting

| symptom | cause / fix |
|---|---|
| `error: port 28090 already in use` | another bus is running — reuse it, or `PORT=28091 npx @antlegion/bus` |
| `sig_failures > 0` in `/info` | the bus restarted with a different (or missing) `ANTLEGION_BUS_SECRET` — set a stable one |
| `error: cannot reach bus at <url>` from alctl/SDK | no bus on that URL — `npx @antlegion/bus`, or point `ANTLEGION_BUS_URL` at the right host |
| `resolve ignored — fact is owned by 'X'` | you lost the claim; that's the system working. Query state, pick other work |
| two units act on the same task | are two processes sharing one identity/author? one identity = one process ([why](research/s2-experiments-2026-08.md)) |

## Architecture

```
 Clients
 ┌──────────────────┐  ┌───────────────┐
 │  ClientV2 (SDK)  │  │  alctl CLI    │
 │  client.ts       │  │  cli.ts       │
 │  - publish       │  │  - publish    │
 │  - claim/resolve │  │  - claim      │
 │  - trust/state   │  │  - tail/info  │
 └────────┬─────────┘  └──────┬────────┘
          │                   │
          └─────────┬─────────┘
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
│   ├── QUICKSTART.md       ← step-by-step: server + SDK + CLI
│   ├── AGENT-CLI.md        ← how agents drive the bus via alctl
│   └── EVOLUTION.md        ← v0 → v1 → v2: what was tried and why it changed
└── antlegion-bus/
    ├── src/
    │   ├── bus.ts          ← stateless trusted core
    │   ├── fold.ts         ← reader folds (the semantics layer)
    │   ├── client.ts       ← ClientV2 folding SDK
    │   ├── server.ts       ← Hono wire surface
    │   ├── log.ts          ← AOF journal
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
- [x] Agent access via `alctl` — every fold verb reachable from a headless/PI agent (`docs/AGENT-CLI.md`)
- [x] §5 causation-depth enforcement at append time
- [x] §4 signature verification on log recovery, `sig_failures` surfaced via `/info`
- [x] Cross-language conformance vectors — hash + fold interop proof with independent Python verifier
- [x] Four multi-agent validation swarms (exactly-once · resilience · consensus · pipeline)
- [x] Docker image · ~160k appends/s in-process benchmark · 147 tests

### Roadmap

**Near — a polished MVP anyone can adopt in five minutes**
- [x] npm packages: [`@antlegion/bus`](https://www.npmjs.com/package/@antlegion/bus) · [`@antlegion/ant`](https://www.npmjs.com/package/@antlegion/ant)
- [x] LLM-acted workers (pi-ai → DeepSeek or any OpenAI-compatible endpoint) — coordination stays deterministic; the LLM only produces content
- [x] `ant init` / `ant start` — guided setup + resident colony
- [x] `npx @antlegion/bus demo` — the three-act killer demo, zero config, zero key
- [x] CI (tests + typecheck + cross-language conformance verifier + wire-break guard)
- [ ] demo GIF in this README · GitHub Releases with notes

**Mid — the measured coordination layer**
- [ ] Multi-language client SDKs — Go, Python, Rust (the [conformance vectors](antlegion-bus/conformance/vectors.json) are the test target, already shipping)
- [ ] Evaluation benchmark: duplicated-work rate, claim-contention outcomes, takeover latency, interception rate — the [S2 experiment series](research/s2-experiments-2026-08.md) is its seed
- [ ] Read-only ops dashboard (fold.ts running in the browser — the reader-fold model as its own observability)
- [ ] Auth + per-author rate limiting for exposed deployments

**Far — the default coordination layer for agent fleets**
- [ ] Replication / HA (single-writer + failover; PROTOCOL.md §7)
- [ ] A DCU ecosystem: role templates (`ant init --template dev-chain` and beyond), any harness's agents as first-class units on one bus — the "Redis of multi-agent coordination"

### Where this came from

This is a second system. The first — [claw_fact_bus](https://github.com/YangKGcsdms/claw_fact_bus) (2026-03, Python) — made the bus an arbiter that pushed facts to interested agents, and died of exactly the diseases this design cures: server-side state, implicit commands, coordination rules living in the runtime. The rewrite deleted everything except what cannot be deleted — the total order — and moved every meaning into reader folds. [EVOLUTION.md](docs/EVOLUTION.md) tells the whole story; building the failed version first is why this one is shaped like this.

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
