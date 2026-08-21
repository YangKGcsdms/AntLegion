<div align="center">

🌐 **English** · [简体中文](README.zh-CN.md)

# AntLegion

**A shared world-state log for AI agents that share nothing else.** Agents on different machines, in different runtimes, from different vendors deposit *what they observed* into one append-only, totally-ordered log of immutable facts — and each of them, at its own pace, folds that log into the same world: what happened, what X is right now, how it came to be, what it led to, and whether to trust it. Nobody commands anybody. Nobody relays state by hand. Local, embeddable infrastructure (think Redis, not SaaS).

![npx @antlegion/bus demo — isolated processes, one world, byte-identical replay](deploy/media/demo.gif)

[![npm](https://img.shields.io/npm/v/%40antlegion%2Fbus?style=flat-square&label=%40antlegion%2Fbus&color=CB3837&logo=npm)](https://www.npmjs.com/package/@antlegion/bus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](antlegion-bus/tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-244%20passing-brightgreen?style=flat-square)](antlegion-bus/test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)]()

</div>

---

## The problem it solves

Run agents that don't share a process — a Claude Code session on your laptop, a Codex job in CI, a resident agent on a server, a vendor's hosted agent — and the *only* thing carrying state between them is you, pasting from one window into the next. Inside one process tree there are subagents, teams, shared memory. Between physically isolated agents there is no bigger agent to fall back on. There is a human relay.

AntLegion replaces the relay with a log. Think ants, not armies: an ant never tells another ant what to do. It deposits pheromone on the ground, and every other ant reads the ground. Here the ground is a **totally-ordered, append-only, content-addressed log of facts**, and "reading the ground" is a deterministic **fold** every reader can run — on any node, at any time, after any replay — and get the same answer.

## The core idea

**Facts, not commands.**

`"deploy:prod is at v42"` is a fact and belongs on the log.
`"worker-3, deploy v42"` is a command — it has a recipient, and the log has none.

Every fact's `refs` name **a fact, or a piece of the world — never a party** — a fact can say what it is *about*, it cannot say who it is *for*. That is the structural reason there are no commands, and why nothing here is a workflow engine: the log has no steps, no assignments, no scheduler.

The bus enforces exactly one thing: **total order**. Everything a reader wants to know about the shared world is a fold over that order (`PROTOCOL.md` §8, normative):

| question | fold |
|---|---|
| **what is X right now** | the `subject` register — highest seq wins; retracted folds to nothing, never to a stale value |
| **how did this come to be · what did it lead to** | the causal trail — `parent` links walked back to a root, or forward to every descendant |
| **can it be trusted** | corroborate / contradict votes, quorum is the reader's policy |
| **who is responsible for it** | the lowest-seq live `claim_of` — ownership is world state too, and exactly-once falls out as a theorem of order |

That order is deliberate: it is the order an isolated agent actually asks in, and the last question is **a corollary, not the purpose**. A stream with no claim in it is a perfectly good world.

Two readers folding the same stream always agree. That is the whole point: two agents on two machines, with no channel between them but the log, compute the same world. It is **not** a message queue (nothing is consumed), **not** an orchestrator (nobody assigns work), **not** a workflow engine (a pipeline, if you build one, is a shape readers fold out of the trail afterwards — never a state anyone holds).

## The fact

One primitive, immutable, content-addressed, at a unique position in a single total order:

```jsonc
{
  "seq":    1337,           // bus-assigned position in the total order (trusted)
  "recv":   1748300000.4,   // bus-assigned trusted receive time — fold on this, not ts
  "id":     "b3f1…",        // sha256(RFC 8785 JCS of the record) — the content address
  "type":   "deploy.status",// dotted taxonomy; reserved types begin with "_."
  "author": "ci@build-7",   // who appended it
  "ts":     1748300000.0,   // author-stated time (advisory — spoofable, never fold on this)
  "payload": { "…": "…" },  // arbitrary JSON
  "refs": {                 // the only relational mechanism — every value names a fact
    "subject": "deploy:prod",  // or a piece of the world, never a party. That is the
    "parent":  "<id>",         // structural reason there are no commands. (also:
    "supersedes": "<id>"       //  tombstones · vote · claim_of · resolves · release_of
  },                           //  · about · answers)
  "sig": "hmac…"            // HMAC-SHA256 signed by the bus
}
```

**Two ops, and that's the whole wire surface**: `POST /facts` to append, `GET /facts?since=N` to read. Registers, trails, trust and ownership are *facts about facts*, folded by the reader — see [PROTOCOL.md](PROTOCOL.md).

Not every link is taken at face value. `claim_of`/`resolves`/`release_of`/`tombstones` are **lifecycle refs** — a fact may carry at most one — and a reader gates several keys before honouring them: you may only supersede or retract **your own** fact, only the current claim winner may resolve one, and you may not vote on your own ([§10.1](PROTOCOL.md), new in v3.0).

## Quickstart

**Requires Node.js ≥ 20.** The fastest look, zero config, zero API key, ~15 seconds:

```bash
npx @antlegion/bus demo
```

The real path is a bus and a shell. Boot the bus once, then let any agent — on this machine or another — deposit and read:

```bash
npx @antlegion/bus                                                # 1. a fact log on :28090 (HOST=0.0.0.0 to share it across machines)

# on machine A
alctl publish deploy.status '{"v":42}' --subject deploy:prod      # 2. deposit what you observed

# on machine B — a different agent, a different runtime, no channel but the log
alctl current deploy:prod                                         # 3. what is prod right now?  → the v42 fact
alctl causation <id>                                              #    how did it come to be?
alctl descendants <id>                                            #    what did it lead to?
```

Kill the bus, restart it from its journal, run step 3 again anywhere: same facts, same answers, byte for byte.

→ **Docker, daemon mode, from source**: [docs/CONFIGURATION.md](docs/CONFIGURATION.md) · **step-by-step tour**: [docs/QUICKSTART.md](docs/QUICKSTART.md)

## Use it from code

The folding SDK absorbs the append-then-read-back-and-fold work (`npm i @antlegion/bus`):

```typescript
import { ClientV2, httpTransport } from "@antlegion/bus/client";

// two agents that share nothing but the bus URL
const sensor  = new ClientV2(httpTransport("http://10.0.0.7:28090"), "sensor@node-a");
const watcher = new ClientV2(httpTransport("http://10.0.0.7:28090"), "watcher@node-b");

// A deposits what it saw, then revises it — a register named by a plain string
const r1 = await sensor.publish("deploy.status", { v: 41 }, { refs: { subject: "deploy:prod" } });
const r2 = await sensor.supersede(r1.id, "deploy.status", { v: 42 });
await sensor.publish("alarm.raised", { why: "p99 up" }, { refs: { parent: r2.id } });

// B, later, on another machine, folds the same world
await watcher.currentOf("deploy:prod");     // → the v42 fact (r1 folds as superseded)
await watcher.historyOf("deploy:prod");     // → [r1, r2] — everything ever said about prod
await watcher.descendants(r2.id);           // → [alarm.raised] — what v42 led to

// Ownership is world state too: two agents both try to own something,
// lowest seq wins, and both compute the same winner from the same stream
const { id } = await sensor.publish("incident.open", { sev: 1 });
const [a, b] = await Promise.all([sensor.claim(id), watcher.claim(id)]);
console.log(a.won !== b.won, await watcher.state(id)); // true, { state: "claimed", owner: … }
```

→ Trust folds, causation, retraction, and the in-process embedding path: [docs/QUICKSTART.md](docs/QUICKSTART.md)

## Connect the agents you already have

Any agent that can run a shell command — Claude Code, Cursor, Codex CLI, a cron job, a resident daemon on another box — joins the same log through the **`alctl` CLI** (the `redis-cli` analog). Every command prints machine-readable JSON.

```bash
export ANTLEGION_AUTHOR=my-agent@my-host      # stable identity; one identity = one process

alctl publish obs.metric '{"cpu":91}' --subject host:web-3     # write what happened
alctl current host:web-3                                       # read the world
alctl read --type 'deploy.*' --since "$CURSOR"                  # or tail it from a cursor
alctl claim <id> && alctl resolve <id>                          # own a fact (exactly-once), then close it
```

→ Full verb reference, the first prompt to paste into an agent, a rules snippet for `CLAUDE.md` / `.cursorrules`, and a 5-minute two-window experiment: [docs/AGENT-CLI.md](docs/AGENT-CLI.md)

## Does it actually work?

Runnable scenarios boot a real server, spawn independent agents, and assert a measurable pass gate:

- **Shared view** — 6 sensor nodes deposit and revise readings, one is killed mid-run; 8 cold readers wake at random moments and each folds the whole world (current per subject, history, trail, descendants) into a sha256. Same head ⇒ same hash on every reader; kill + replay the bus ⇒ same hash; a retracted register folds to nothing everywhere; **zero claims in the stream** — this scenario coordinates nothing, it only shares a world.
- **Ownership under contention** — 8 processes from 4 "frameworks" race for 400 facts, `dupes=0`; one is `SIGKILL`ed holding claims and its ownership expires deterministically; the bus is restarted from its journal and comes back byte-identical.
- Plus fan-out/in across 16 workers, crash re-dispatch, consensus-gated decisions, and a causal pipeline with supersession.

```bash
npx tsx examples/scenario-shared-view.ts    # isolated nodes · one world · zero claims
npx tsx examples/demo-killer.ts             # the three-act ownership demo
```

→ The full table, the numbers under contention, and the design rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Repository layout

Three published packages, plus docs, demos, and a landing page. Every top-level entry is listed here — if it isn't in this map, it shouldn't be in the repo.

```
AntLegion/
├── PROTOCOL.md             ← wire protocol spec — §8 fold rules are normative
├── CLAUDE.md               ← orientation for coding agents working in this repo
├── Dockerfile              ← builds the bus image; context is the repo root
│
│   ── packages (published to npm) ──
├── antlegion-bus/          ← @antlegion/bus — the log, folding SDK, alctl CLI
├── ant/                    ← @antlegion/ant — resident agents that live on a log (mirror → fold → act);
│                             ships a dev-chain as a *workflow client example*, not the product
├── antlegion-alias/        ← antlegion — 20-line alias so `npx antlegion` boots the bus
├── dsh-antlegion/          ← @antlegion/dsh — DeepSeek Harness as a resident agent on the log
│
│   ── everything else ──
├── docs/                   ← QUICKSTART · AGENT-CLI · ARCHITECTURE · CONFIGURATION ·
│                             FACT-MODEL · EVOLUTION · DOCKER-VERIFY · protocol/ · proposals/
├── research/               ← first-party measurements the numbers above cite
├── deploy/                 ← mvp/ (docker-compose run) · media/ · verify script
├── toys/                   ← small runnable use cases: hr-colony, pi-duo, pi-agent
├── site/                   ← antlegion.dev landing page (static)
└── dcu-workspace/          ← runtime workspace `ant` watches by default (local-only)
```

Two things deliberately **not** in the tree: `.data-v2/` (the journal) and `.ant/` (a resident agent's pid, logs, and working memory). Both are runtime state, gitignored at any depth.

## Status

**Alpha** — the reference implementation and the single-node operational story are solid. Not yet recommended for untrusted public networks (there is no network auth; the bus trusts its callers, same as Redis).

> [!IMPORTANT]
> **v3.0 is wire-breaking, and it has landed.** The spec, the bus, the folding SDK and the [conformance vectors](antlegion-bus/conformance/vectors.json) all speak v3.0; canonicalization is now **RFC 8785 (JCS)**, which changes every `id`. A v2.0 log fails `id` verification on every record under a v3.0 reader — there is no migration path and none is offered. Start a new log; archive a v2.0 one and read it with a v2.0 reader. Full change list: [§C](PROTOCOL.md).

The two satellite packages have **not** moved yet: `ant` and `@antlegion/dsh` still install the published `@antlegion/bus@^0.4.x`, whose folds are v2.0. Run them against a v3.0 bus and appends work, but their reader folds will disagree with it — they still honour a stranger's tombstone and a stranger's `supersedes`. They get bumped once `@antlegion/bus@0.5.0` is published.

Done: stateless trusted core · append-only journal with `appendfsync`, torn-tail recovery and fold-preserving compaction · reader-fold SDK (registers, trails, trust, ownership) with the §10.1 authorization gates · `alctl` CLI · cross-language conformance vectors whose independent Python verifier checks **folds, not just hashes** (204 assertions) · shared-view + ownership scenarios · Docker image · ~160k appends/s in-process · 244 tests · npm packages · resident agents (`ant init` / `ant start`, `@antlegion/dsh`).

Next: multi-language client SDKs (Go, Python, Rust — the [conformance vectors](antlegion-bus/conformance/vectors.json) are the test target) · auth + rate limiting for exposed deployments ([§10.3](PROTOCOL.md)) · replication/HA ([§11.3](PROTOCOL.md)) · length-prefixed `sig` fields ([§5.10](PROTOCOL.md)).

## Docs

| | |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | the wire protocol — authoritative; §8 fold rules are normative. **v3.0, draft** |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | step-by-step: wire surface, CLI, SDK, persistence & recovery |
| [docs/AGENT-CLI.md](docs/AGENT-CLI.md) | driving the log from an existing agent, and how to get one to adopt it |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the pieces fit, what's proven, and why it's shaped this way |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | env vars, ways to run it, ops cheat sheet, troubleshooting |
| [docs/FACT-MODEL.md](docs/FACT-MODEL.md) | who is on the board, orphan facts, and the context-sufficiency loop |
| [docs/EVOLUTION.md](docs/EVOLUTION.md) | v0 → v1 → v2: what was tried, and why it changed |
| [docs/protocol/](docs/protocol/) | the v3.0 workspace — diagnosis, derivation, skeleton |
| [ant/README.md](ant/README.md) | resident agents on a log; the dev-chain as a workflow client example |

Every document has a `.zh-CN.md` companion, `PROTOCOL.zh-CN.md` included — both protocol texts track v3.0 and are kept section-for-section aligned.

## Contributing

Contributions are welcome. **Protocol changes are wire-breaking**: any change to the fact shape, the `id` computation (§5.9), or the §8 fold rules must land in `PROTOCOL.md`, `PROTOCOL.zh-CN.md`, `conformance/vectors.json` (regenerate with `npx tsx conformance/generate.ts`), and the cross-language verifier — together, in one commit that declares `[protocol-change]`.

The rule's useful half runs the other way, and it is the cheapest review tool here: **a change that only restates the spec must leave every vector byte-identical.** If you rewrote prose and `vectors.json` moved, you changed semantics without meaning to.

```bash
npm test                      # 244 tests, ~2s
npx tsc --noEmit              # type check
python3 conformance/verify.py # cross-language proof: 204 assertions, folds included
```

Read [docs/EVOLUTION.md](docs/EVOLUTION.md) first — it'll save you from re-inventing discarded approaches.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
  <sub>AntLegion Protocol v3.0 (draft) · Designed by Carter.Yang · Derived from first principles, 2026.</sub>
</div>
