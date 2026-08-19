🌐 **English** · [简体中文](ARCHITECTURE.zh-CN.md)

# Architecture — how the pieces fit, and what is proven

The [README](../README.md) states the idea; [PROTOCOL.md](../PROTOCOL.md) is the normative spec. This page sits between them: the shape of the implementation, why it is shaped that way, and the evidence that it holds.

## Key properties

| Property | How it works |
|---|---|
| **Immutable facts** | Content-addressed by `sha256(canonical(record))` — identical content is deduplicated automatically; every fact has a stable, forgery-proof identity |
| **Total order** | The bus assigns a strictly increasing `seq`; this is its only authority over clients |
| **Shared registers** | A `refs.subject` names a piece of the world; the highest-`seq` fact about it is its current value on every reader (`current`/`history`); a tombstone retracts it to nothing, never to a stale value |
| **Causal trail** | `refs.parent` walked back gives "how did this come to be", forward gives "what did it lead to" — content-hashed, so unforgeable after the fact |
| **Exactly-once ownership** | The lowest-`seq` claim on any fact wins — ownership is world state too; a theorem of total order, not a lock or a special-purpose endpoint |
| **Trusted time** | Bus-stamped `recv` (not author-stated `ts`) anchors all time-based folds deterministically; a crashed agent's stale claim cannot block recovery |
| **Stateless bus** | Registers, trails, trust, ownership are pure fold functions over the stream — the bus holds no per-fact mutable state; two isolated readers always fold the same world |
| **Durable** | Append-only journal (`facts-v2.jsonl`) with configurable `appendfsync` policy; crash recovery replays the log — no state machine to rebuild |
| **Verifiable** | Every fact is HMAC-signed by the bus; signature verified on recovery; interop guaranteed by a [cross-language conformance vector set](../antlegion-bus/conformance/vectors.json) |

## What it is — and isn't

Not a message queue (nothing is consumed), not an orchestrator (nobody assigns work), not a workflow engine (the pipeline is folded out of the stream, never stored). Against the other ways people coordinate agents today:

| | shared files / scratchpad | SQLite mailbox | hosted coordination SaaS | platform built-in shared state (Agent-Teams-style) | **AntLegion** |
|---|---|---|---|---|---|
| total order | ✗ | per-table, implicit | opaque | opaque | ✓ the core primitive |
| exactly-once claiming | ✗ (locks, hope) | ✗ (row locks) | vendor-defined | vendor-defined | ✓ theorem of the order |
| causality / audit | ✗ | ✗ | partial | partial | ✓ `refs` + signed log |
| local & embeddable | ✓ | ✓ | ✗ | ✗ | ✓ one process, one file |
| cross-harness | ✓ (barely) | ✓ | agent-framework-specific | single vendor | ✓ HTTP + CLI + SDK, any agent |
| open protocol | — | — | ✗ | ✗ | ✓ [PROTOCOL.md](../PROTOCOL.md) + conformance vectors |

### Three mechanisms, one collaboration model

**Persistence lets agents share reality. Claiming lets them divide work. Causation lets workflows emerge.** Everything else in the system is one of these three, read from the same ordered log — persistence is the append-only journal ([§1](../PROTOCOL.md)), claiming is the lowest-seq theorem ([§3.1](../PROTOCOL.md)), causation is `refs.parent` chains ([§3.4](../PROTOCOL.md)).

## The implementation

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

## Validated guarantees

The founding premise is exercised by four runnable swarms in [`antlegion-bus/examples/`](../antlegion-bus/examples). Each boots a real server, spawns ~20 autonomous agents, and asserts a concrete, measurable pass gate:

| Swarm | What it proves | Pass gate |
|---|---|---|
| [`swarm-v2`](../antlegion-bus/examples/swarm-v2.ts) | 50-item fan-out/in across 16 workers with 460 competing claims — **exactly-once**, zero agent-to-agent addressing | `dupes=0  missing=0` |
| [`scenario-resilience`](../antlegion-bus/examples/scenario-resilience.ts) | Agents crash mid-work; **claim-timeout re-dispatch** transfers ownership; exactly-once survives | no stuck items |
| [`scenario-consensus`](../antlegion-bus/examples/scenario-consensus.ts) | Peer review converges; the decider acts **only on consensus**, never on refuted facts | decider never acts on refuted |
| [`scenario-pipeline`](../antlegion-bus/examples/scenario-pipeline.ts) | Causal `build→test→deploy` with latest-wins **supersession**; all monitors agree on the single fresh status | all monitors agree |

```bash
npx tsx examples/swarm-v2.ts
npx tsx examples/scenario-resilience.ts
npx tsx examples/scenario-consensus.ts
npx tsx examples/scenario-pipeline.ts
```

Each example self-boots its own bus on an ephemeral port — no bus needed beforehand.

### The killer demo

[`demo-killer`](../antlegion-bus/examples/demo-killer.ts) compresses the whole pitch into ~13 seconds, in three acts: **(1)** 8 agent processes from 4 "frameworks" race for 400 tasks — duplicates: 0, decided by total order, not a lock; **(2)** a real process is `SIGKILL`ed mid-work and its orphaned claims expire on the trusted bus clock and are re-won by survivors — no orchestrator was notified, none exists; **(3)** the bus itself is killed and restarted from the journal — `head_seq`, stream hash, and every task's owner/state come back byte-identical.

```bash
npx tsx examples/demo-killer.ts
```

Pair it with the zero-dependency live dashboard in [`demo/`](../antlegion-bus/demo) — a task grid, per-agent cards, and a duplicate counter updating in real time in your browser, with automatic replay-verification when the bus restarts. See [`demo/README.md`](../antlegion-bus/demo/README.md).

### Measured under contention

The swarms above are pass/fail gates. For numbers — duplicated-work rate under replicated workers, forged-evidence interception — see [`research/s2-experiments-2026-08.md`](../research/s2-experiments-2026-08.md): **0 double-executions across 100 claim units with 4× replicated workers racing**, and forged "all green" reports intercepted at **8/8 with 0 false kills**.

## Where this came from

This is a second system. The first — [claw_fact_bus](https://github.com/YangKGcsdms/claw_fact_bus) (2026-03, Python) — made the bus an arbiter that pushed facts to interested agents, and died of exactly the diseases this design cures: server-side state, implicit commands, coordination rules living in the runtime. The rewrite deleted everything except what cannot be deleted — the total order — and moved every meaning into reader folds. [EVOLUTION.md](EVOLUTION.md) tells the whole story; building the failed version first is why this one is shaped like this.
