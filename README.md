<div align="center">

🌐 **English** · [简体中文](README.zh-CN.md)

# AntLegion

**Run several AI agents on the same project and they re-do each other's work, lose each other's context, and drift apart.** AntLegion fixes this at the fact level: an append-only **fact bus** where autonomous work units post what happened, claim work exactly-once, and let the workflow emerge — no orchestrator, nobody commands anybody. Local, embeddable infrastructure (think Redis, not SaaS).

![npx @antlegion/bus demo — exactly-once race, crash takeover, byte-identical replay](deploy/media/demo.gif)

[![npm](https://img.shields.io/npm/v/%40antlegion%2Fbus?style=flat-square&label=%40antlegion%2Fbus&color=CB3837&logo=npm)](https://www.npmjs.com/package/@antlegion/bus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](antlegion-bus/tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-147%20passing-brightgreen?style=flat-square)](antlegion-bus/test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)]()

</div>

---

## The core idea

**Facts, not commands.**

`"item 7 needs processing"` is a fact and belongs on the bus.
`"worker-3, process item 7"` is a command — it has no place here.

No agent ever addresses another. Agents publish observations about the world, read the shared log at their own pace, and react. Who works on what, in what order, with what confidence — all of it emerges from the structure of the fact stream.

The bus enforces exactly one thing: **total order**. From total order, exactly-once assignment falls out as a mathematical theorem: **the claim with the lowest sequence number wins**, and every reader computes the same winner from the same immutable stream. No locks, no leases, no coordinator.

That single choice is what fixes the three things that go wrong when several agents share a project:

- **Duplicated work** — picking up work *is* a fact (`_.claim`), so two agents can't both think they own it. Measured at **0 double-executions across 100 claim units with 4× replicated workers racing**.
- **Lost context** — every observation is an immutable, content-addressed fact any unit can fold at its own pace, instead of prose that never reaches agent B.
- **Workflows held together by prose** — the pipeline is causal structure (`refs.parent`), and evidence shapes are enforced by an adjudicator; forged "all green" reports were intercepted **8/8 with 0 false kills**.

It is **not** a message queue (nothing is consumed), **not** an orchestrator (nobody assigns work), **not** a workflow engine (the pipeline is folded out of the stream, never stored). It doesn't lock files or serialize your agents — conflicts are eliminated at the division-of-work layer, before two units ever touch the same task.

## The fact

One primitive, immutable, content-addressed, at a unique position in a single total order:

```jsonc
{
  "seq":    1337,           // bus-assigned position in the total order (trusted)
  "recv":   1748300000.4,   // bus-assigned trusted receive time — fold on this, not ts
  "id":     "b3f1…",        // sha256(canonical(record)) — the content address
  "type":   "build.failed", // dotted taxonomy; reserved types begin with "_."
  "author": "claude-code",  // who appended it
  "ts":     1748300000.0,   // author-stated time (advisory — spoofable, never fold on this)
  "payload": { "…": "…" },  // arbitrary JSON
  "refs": {                 // the only relational mechanism — all values are fact ids,
    "parent":   "<id>",     // never agent ids. That is the structural reason
    "claim_of": "<id>",     // there are no commands.
    "resolves": "<id>"      // (also: release_of · vote · supersedes · subject · tombstones)
  },
  "sig": "hmac…"            // HMAC-SHA256 signed by the bus
}
```

**Two ops, and that's the whole wire surface**: `POST /facts` to append, `GET /facts?since=N` to read. Claim, resolve, trust, supersession and causation are *facts about facts*, folded by the reader — see [PROTOCOL.md](PROTOCOL.md) (§3 fold rules are normative).

## Quickstart

**Requires Node.js ≥ 20.** The fastest look — the three-act demo (exactly-once race → crash takeover → byte-identical replay), zero config, zero API key, ~15 seconds:

```bash
npx @antlegion/bus demo
```

The real path is two packages and four commands: boot a bus, put a fleet of work units on it, feed it a task, watch it run.

```bash
npx @antlegion/bus                              # 1. a fact bus on :28090
npx @antlegion/ant chain                        # 2. the dev-chain fleet (6 work units)
npx @antlegion/ant req new "pilot" -s pilot     # 3. feed it a requirement
npx @antlegion/ant board                        # 4. → http://localhost:28091/devchain.html
```

Within ~2s `dcu-plan` claims the requirement (exactly-once, lowest seq wins), produces `plan.ready`, an adjudicator checks its evidence shape, and the chain parks at a human gate — approve it on the board and dev → unittest → e2e run themselves to ✔ CHAIN DONE. No orchestrator, no unit addressing another.

→ **Docker, daemon mode, from source**: [docs/CONFIGURATION.md](docs/CONFIGURATION.md) · **step-by-step tour**: [docs/QUICKSTART.md](docs/QUICKSTART.md)

## Use it from code

The folding SDK absorbs the append-then-read-back-and-fold work (`npm i @antlegion/bus`):

```typescript
import { ClientV2, httpTransport } from "@antlegion/bus/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

const { id } = await alice.publish("task.build", { target: "todo-app" });

// Both race to claim; lowest seq wins — deterministic, no locks
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]);
const winner = ra.won ? alice : bob;

// Winner resolves, optionally emitting child facts (causation chain)
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);

console.log(await alice.state(id)); // { state: "resolved", owner: "alice" }
console.log(await bob.state(id));   // identical — same stream, same fold
```

→ Peer-review trust folds, causation chains, supersession, and the in-process embedding path: [docs/QUICKSTART.md](docs/QUICKSTART.md)

## Connect the agents you already have

Any agent that can run a shell command — Claude Code, Cursor, Codex CLI, a cron job — joins the same bus through the **`alctl` CLI** (the `redis-cli` analog). Every command prints machine-readable JSON; a lost claim exits non-zero.

```bash
export ANTLEGION_AUTHOR=my-agent          # stable identity; one identity = one process

alctl read --type 'task.*' --since "$CURSOR"   # read new facts
alctl claim <id> && alctl resolve <id>         # claim exactly-once, then resolve
alctl publish task.done '{"result":"ok"}' --parent <id>
```

→ Full verb reference, the first prompt to paste into an agent, a rules snippet for `CLAUDE.md` / `.cursorrules`, and a 5-minute two-window experiment: [docs/AGENT-CLI.md](docs/AGENT-CLI.md)

## Does it actually work?

Four runnable swarms boot a real server, spawn ~20 autonomous agents, and assert a measurable pass gate — exactly-once fan-out (`dupes=0 missing=0`), crash + claim-timeout re-dispatch, consensus-gated decisions, causal pipeline with supersession. Plus a ~13-second demo where 8 processes race for 400 tasks, one is `SIGKILL`ed mid-work, and the bus itself is restarted from its journal to come back byte-identical.

```bash
npx tsx examples/demo-killer.ts     # the three-act version
```

→ The full table, the numbers under contention, and the design rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Repository layout

Three published packages, plus docs, demos, and a landing page. Every top-level entry is listed here — if it isn't in this map, it shouldn't be in the repo.

```
AntLegion/
├── PROTOCOL.md             ← wire protocol spec — §3 fold rules are normative
├── CLAUDE.md               ← orientation for coding agents working in this repo
├── Dockerfile              ← builds the bus image; context is the repo root
│
│   ── packages (published to npm) ──
├── antlegion-bus/          ← @antlegion/bus — the bus, folding SDK, alctl CLI
├── ant/                    ← @antlegion/ant — work-unit runtime, dev-chain fleet, boards
├── antlegion-alias/        ← antlegion — 20-line alias so `npx antlegion` boots the bus
│
│   ── everything else ──
├── docs/                   ← QUICKSTART · AGENT-CLI · ARCHITECTURE · CONFIGURATION ·
│                             FACT-MODEL · EVOLUTION · DOCKER-VERIFY · proposals/
├── research/               ← first-party measurements the numbers above cite
├── deploy/                 ← mvp/ (docker-compose fleet run) · media/ · verify script
├── toys/                   ← small runnable use cases: hr-colony, pi-duo, pi-agent
├── site/                   ← antlegion.dev landing page (static)
└── dcu-workspace/          ← runtime workspace `ant` watches by default (local-only)
```

Two things deliberately **not** in the tree: `.data-v2/` (the bus journal) and `.ant/` (a colony's pid, logs, and working memory). Both are runtime state, gitignored at any depth.

## Status

**Alpha** — the core protocol, reference implementation, and single-node operational story are solid. Not yet recommended for untrusted public networks (there is no auth; the bus trusts its callers, same as Redis).

Done: stateless trusted core · append-only journal with `appendfsync` + compaction · reader-fold SDK · `alctl` CLI · cross-language conformance vectors with an independent Python verifier · four validation swarms · Docker image · ~160k appends/s in-process · 147 tests · npm packages · LLM-acted work units · resident colonies (`ant init` / `ant start`).

Next: multi-language client SDKs (Go, Python, Rust — the [conformance vectors](antlegion-bus/conformance/vectors.json) are the test target) · a coordination benchmark seeded by the [S2 experiments](research/s2-experiments-2026-08.md) · auth + rate limiting for exposed deployments · replication/HA ([§7](PROTOCOL.md)).

## Docs

| | |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | the wire protocol — authoritative; §3 fold rules are normative |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | step-by-step: wire surface, CLI, SDK, persistence & recovery |
| [docs/AGENT-CLI.md](docs/AGENT-CLI.md) | driving the bus from an existing agent, and how to get one to adopt it |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the pieces fit, what's proven, and why it's shaped this way |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | env vars, ways to run it, ops cheat sheet, troubleshooting |
| [docs/FACT-MODEL.md](docs/FACT-MODEL.md) | interests, orphan facts, and the context-sufficiency loop |
| [docs/EVOLUTION.md](docs/EVOLUTION.md) | v0 → v1 → v2: what was tried, and why it changed |
| [ant/README.md](ant/README.md) | the work-unit model, the dev-chain, evidence adjudication, boards |

Every document has a `.zh-CN.md` companion.

## Contributing

Contributions are welcome. **Protocol changes are wire-breaking**: any change to the fact shape, the `id` computation (§4), or the §3 fold rules must land in `PROTOCOL.md`, `conformance/vectors.json` (regenerate with `npx tsx conformance/generate.ts`), and the cross-language verifier — together, in one commit that declares `[protocol-change]`.

```bash
npm test                      # 147 tests, ~1s
npx tsc --noEmit              # type check
python3 conformance/verify.py # cross-language hash proof
```

Read [docs/EVOLUTION.md](docs/EVOLUTION.md) first — it'll save you from re-inventing discarded approaches.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
  <sub>AntLegion Protocol v2.0 · Designed by Carter.Yang · Derived from first principles, 2026.</sub>
</div>
