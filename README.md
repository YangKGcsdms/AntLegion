🌐 **English** · [简体中文](README.zh-CN.md)

# AntLegion

> A **fact bus** for autonomous agents — local, embeddable infrastructure that
> lets many agents coordinate by sharing *facts*, never by sending each other
> *commands*. Think of it as a Redis-shaped primitive for multi-agent
> collaboration: install it, run it, point your agents at it.

---

## What it is

A small server that stores **immutable, content-addressed facts** in a single
totally-ordered, append-only log. Agents *publish* facts, *read* them on their
own cadence, optionally *claim* exclusive ones and *resolve* them, and
*corroborate / contradict* each other's facts. Coordination is not orchestrated
— it **emerges** from the fact stream and its causation links.

The founding axiom: **facts, not commands.** `"item 7 needs processing"` is a
fact; `"worker-3, process item 7"` is a command and has no place on the bus. No
agent ever addresses another; they only make and react to statements about the
world. (This is validated, not aspirational — see [Validated](#what-is-validated).)

## Where it sits

| It **is** | It is **not** |
|---|---|
| Local / embeddable infra you run next to your agents (à la Redis) | A public-internet SaaS |
| A durable, ordered, append-only **fact log** with reader-side folds | A message queue / RPC bus |
| Choreography: agents self-coordinate via shared facts | An orchestrator that sequences agents |
| Single-node, single-writer (HA = failover, not multi-master) | A multi-master distributed database |

Lineage: CAN bus (content-addressed broadcast + local filtering), event sourcing
(the log is the only truth), git (content hashing + cursor `fetch`), and the
scientific method (peer-reviewed, contestable facts).

## Architecture (one)

One primitive, one bus. A fact is an immutable, content-addressed statement in a
single total order; the bus only assigns order, verifies the content hash, stamps
a trusted time, signs, persists, and serves a range. Claim, resolve, trust,
supersession, and causation are **reader folds** over the fact stream
([`PROTOCOL.md`](PROTOCOL.md) §3) — the bus holds no per-fact state. The smarts
live in one place: the client SDK / `alctl` CLI / MCP adapter, all in
[`antlegion-bus/src/`](antlegion-bus/src). Start here: [`QUICKSTART.md`](docs/QUICKSTART.md).

> An earlier **v1** — a mutable-state bus plus a separate MCP package — was
> removed once this design superseded it; it lives on in git history. See
> [`EVOLUTION.md`](docs/EVOLUTION.md).

## Quickstart (v2, 60 seconds)

```bash
cd antlegion-bus
npm install
npm run dev          # http://localhost:28090   (or: npm run build && npm run start)
```

Drive it from the terminal with `alctl` (the redis-cli analog), or from code:

```ts
import { ClientV2, httpTransport } from "antlegion-bus/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

const { id } = await alice.publish("task.build", { target: "todo-app" });
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]); // exactly one wins
const winner = ra.won ? alice : bob;
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);
await bob.state(id);    // → { state: "resolved", owner: <winner> }  (folded from the log)
```

Full version, including persistence and the CLI: [`QUICKSTART.md`](docs/QUICKSTART.md).

## What is validated

The premise — *agents collaborate through facts, no commands* — is exercised by
runnable swarms in [`antlegion-bus/examples/`](antlegion-bus/examples) (each
boots a server, spawns ~20 autonomous agents, and asserts an objective pass
gate):

| Swarm | Proves |
|---|---|
| `swarm-v2` | 50-item fan-out/in, **exactly-once** across 16 workers, zero agent-to-agent messages |
| `scenario-resilience` | crashed agents recovered via **claim-timeout re-dispatch** — exactly-once survives failure |
| `scenario-consensus` | peer review converges truth; a decider acts **only on consensus**, never on refuted facts |
| `scenario-pipeline` | causal stages (`build→test→deploy`) + latest-wins **supersession**; all monitors agree on one fresh status |

```bash
npx tsx examples/swarm-v2.ts          # and scenario-{resilience,consensus,pipeline}.ts
```

## Repository map

```
.
├── README.md          ← you are here   (every doc also ships a .zh-CN.md)
├── PROTOCOL.md        ← the wire protocol (§3 fold rules are normative)
├── Dockerfile         ← run the bus like you run redis (build from the repo root)
├── CLAUDE.md          ← guidance for Claude Code working in this repo
├── docs/
│   ├── QUICKSTART.md  ← 60-second quickstart (server + SDK + alctl + MCP)
│   └── EVOLUTION.md   ← why the project looks like this (v0 → v1 → v2)
└── antlegion-bus/
    ├── src/           ← core (bus.ts), server, fold SDK (client.ts), alctl CLI, MCP adapter (mcp.ts), AOF (log.ts), bench
    ├── conformance/   ← vectors.json (the §4 interop contract) + generate.ts + a Python verifier
    ├── examples/      ← multi-agent validation swarms
    └── test/          ← unit suite (136 tests)
```

## Status

**Alpha.** Done: stateless core, HTTP wire, fold SDK, `alctl` CLI, **MCP adapter**
(`npm run mcp`), append-only persistence with `appendfsync` policy + compaction,
`INFO`, `§5` causation-depth enforcement, signature **verification** on recovery,
**cross-language conformance vectors** (`conformance/vectors.json` + an
independent Python verifier that reproduces every hash byte-for-byte),
benchmark (~160k appends/s in-process), Docker image, and 136 passing
tests + 4 multi-agent validation swarms. Not yet: multi-language client SDKs,
clustering/replication, and a published package or prebuilt binary (build from
source for now).

## License

MIT. See [LICENSE](LICENSE).
