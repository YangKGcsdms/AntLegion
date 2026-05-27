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

## Two generations in this repo

- **v2 — current, recommended.** A first-principles redesign: one primitive
  (a fact in a total order), two ops (`append` / `read`), and everything else —
  claim, resolve, trust, supersession, causation — is a **reader fold**. The
  bus is a stateless trusted core; an SDK and CLI carry the smarts. Code lives
  in [`antlegion-bus/src/v2/`](antlegion-bus/src/v2). Spec: [`PROTOCOL.md`](PROTOCOL.md).
  Start here: [`QUICKSTART.md`](QUICKSTART.md).

- **v1 — legacy.** The original bus (`antlegion-bus/src/`) plus an **MCP
  adapter** ([`antlegion-mcp/`](antlegion-mcp)) that lets MCP clients (Claude
  Code, Cursor, Cline, …) join a bus with one line of config. Retained because
  it is currently the only *zero-code* path for MCP clients; a v2 MCP adapter is
  planned. Spec: [`PROTOCOL-v1-historical.md`](PROTOCOL-v1-historical.md).
  Walkthrough: [`QUICKSTART-v1-mcp.md`](QUICKSTART-v1-mcp.md).

If you are starting fresh, use **v2**.

## Quickstart (v2, 60 seconds)

```bash
cd antlegion-bus
npm install
npm run dev:v2          # http://localhost:28090   (or: npm run build && npm run start:v2)
```

Drive it from the terminal with `alctl` (the redis-cli analog), or from code:

```ts
import { ClientV2, httpTransport } from "antlegion-bus/v2/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

const { id } = await alice.publish("task.build", { target: "todo-app" });
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]); // exactly one wins
const winner = ra.won ? alice : bob;
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);
await bob.state(id);    // → { state: "resolved", owner: <winner> }  (folded from the log)
```

Full version, including persistence and the CLI: [`QUICKSTART.md`](QUICKSTART.md).

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
├── README.md                  ← you are here
├── PROTOCOL.md                ← v2 wire protocol (current)
├── PROTOCOL-v1-historical.md  ← v1 protocol (archived)
├── QUICKSTART.md              ← v2 quickstart (server + SDK + alctl)
├── QUICKSTART-v1-mcp.md       ← v1 / MCP quickstart (legacy)
├── EVOLUTION.md               ← why the project looks like this (v0→v1→v2)
├── CLAUDE.md                  ← guidance for Claude Code working in this repo
├── docker-compose.yml         ← runs the v1 bus
├── antlegion-bus/
│   ├── src/                   ← v1 bus engine (legacy)
│   ├── src/v2/                ← v2: core, server, fold SDK, alctl CLI, AOF, bench
│   ├── examples/              ← multi-agent validation swarms (v2)
│   ├── test/  test/v2/        ← unit suites (244 tests total)
│   └── Dockerfile-v2          ← run the v2 bus like you run redis
└── antlegion-mcp/             ← v1 MCP adapter (legacy)
```

## Status

**Alpha.** Done in v2: stateless core, HTTP wire, fold SDK, `alctl` CLI,
append-only persistence with `appendfsync` policy + compaction, `INFO`,
benchmark (~160k appends/s in-process), Docker image, and 244 passing tests with
4 multi-agent validation swarms. Not yet: a v2 MCP adapter, multi-language
client SDKs / cross-language conformance vectors, clustering/replication, and a
published package or prebuilt binary (build from source for now).

## License

MIT. See [LICENSE](LICENSE).
