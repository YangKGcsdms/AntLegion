<div align="center">

🌐 **English** · [简体中文](README.zh-CN.md)

# AntLegion

**A shared world-state log for AI agents that share nothing else.** Agents on different machines, in different runtimes, from different vendors deposit *what they observed* into one append-only, totally-ordered log of immutable facts — and each derives what happened, what X is right now, how it came to be, and whether to trust it. Matching log positions, rules, parameters and calculation times give matching results. The bus does not dispatch commands. Local, embeddable infrastructure (think Redis, not SaaS).

![npx @antlegion/bus demo — isolated processes, one world, byte-identical replay](deploy/media/demo.gif)

[![npm](https://img.shields.io/npm/v/%40antlegion%2Fbus?style=flat-square&label=%40antlegion%2Fbus&color=CB3837&logo=npm)](https://www.npmjs.com/package/@antlegion/bus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](antlegion-bus/tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-regression%20suite-brightgreen?style=flat-square)](antlegion-bus/test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)]()

</div>

---

## The problem it solves

Run agents that don't share a process — a Claude Code session on your laptop, a Codex job in CI, a resident agent on a server, a vendor's hosted agent — and the *only* thing carrying state between them is you, pasting from one window into the next. Inside one process tree there are subagents, teams, shared memory. Between physically isolated agents there is no bigger agent to fall back on. There is a human relay.

AntLegion provides a **totally-ordered, append-only, content-addressed log of facts**. Each reader derives state by applying fold rules to the log. Replaying the same records with the same rules and inputs reproduces that state; readers at different positions or using different parameters may disagree.

## The core idea

**Facts, not commands.**

`"deploy:prod is at v42"` is a fact and belongs on the log.
`"worker-3, deploy v42"` is an instruction; storing that text does not cause the bus to dispatch or execute it.

`refs.subject` names a subject; the other defined relation keys point at **fact ids**. Unknown extension keys and arbitrary JSON content are accepted within the input rules. "No commands" means the bus does not address, dispatch, or force execution; it does not mean JSON cannot contain instructions. Workflow steps and scheduling belong to clients.

The bus assigns **total order**, validates content, and preserves the log. Everything a reader wants to know about the shared world is a fold over that order (`PROTOCOL.md` §3, normative):

| question | fold |
|---|---|
| **what is X right now** | the `subject` register — highest seq wins; retracted folds to nothing, never to a stale value |
| **how did this come to be · what did it lead to** | the causal trail — `parent` links walked back to a root, or forward to every descendant |
| **can it be trusted** | corroborate / contradict votes, quorum is the reader's policy |
| **who owns it** | the lowest-seq live `claim_of` — a shared ownership result, not exactly-once external execution |

Readers agree at the same log position with the same rules, parameters and calculation time. Trust thresholds can differ by reader; trailing claim expiry depends on the supplied time. The bus provides a shared log; workflow decisions remain in clients.

## The fact

One primitive, immutable, content-addressed, at a unique position in a single total order:

```jsonc
{
  "seq":    1337,           // bus-assigned position in the total order (trusted)
  "recv":   1748300000.4,   // bus-assigned trusted receive time — fold on this, not ts
  "id":     "b3f1…",        // sha256(canonical(record)) — the content address
  "type":   "deploy.status",// dotted taxonomy; reserved types begin with "_."
  "author": "ci@build-7",   // who appended it
  "ts":     1748300000.0,   // author-stated time (advisory — spoofable, never fold on this)
  "payload": { "…": "…" },  // plain JSON object
  "refs": {                 // subject names and fact relationships
    "subject": "deploy:prod",  // a subject name, not a fact id
    "parent":  "<id>",         // a fact id
    "supersedes": "<id>"       // (also: tombstones · vote · claim_of · resolves · release_of)
  },
  "sig": "hmac…"            // HMAC-SHA256 signed by the bus
}
```

**Two ops, and that's the whole wire surface**: `POST /facts` to append, `GET /facts?since=N` to read. Registers, trails, trust and ownership are *facts about facts*, folded by the reader — see [PROTOCOL.md](PROTOCOL.md).

Inputs are normalized and copied before hashing and storage. The official Node encoding is the current baseline; committed vectors are regression cases, not a complete cross-language contract. Retrying an append requires the original input, including `ts` and `nonce`; a fresh helper call may create a new fact. See [PROTOCOL.md §4](PROTOCOL.md#4-identity--integrity).

For a self-hosted Docker console with an access token and isolated home demo, see [Home deployment](deploy/home/README.md).

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

For anything you want to keep running, run it the way you run Redis — a container, a volume, a stable secret:

```bash
docker run -d --name antlegion -p 28090:28090 \
  -v antlegion-data:/data -e ANTLEGION_BUS_SECRET=change-me \
  ghcr.io/yangkgcsdms/antlegion          # multi-arch; :latest tracks the newest bus-v* tag
```

The image binds `0.0.0.0` inside the container — the docker network is the trust boundary, so publish the port only where you trust the callers. The volume is the entire persistence story: one append-only journal, which is why a restarted container folds the same world instead of a fresh one. Keep `ANTLEGION_BUS_SECRET` stable — unset, the bus mints a new HMAC key each boot and signatures written before the restart stop verifying (they surface as `sig_failures` in `/info`). To build it yourself, from the repo root: `docker build -t antlegion .`

→ **daemon mode, from source, the full env table**: [docs/CONFIGURATION.md](docs/CONFIGURATION.md) · **step-by-step tour**: [docs/QUICKSTART.md](docs/QUICKSTART.md)

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
alctl claim <id> && alctl resolve <id>                          # confirm ownership, then record completion
```

→ Full verb reference, the first prompt to paste into an agent, a rules snippet for `CLAUDE.md` / `.cursorrules`, and a 5-minute two-window experiment: [docs/AGENT-CLI.md](docs/AGENT-CLI.md)

## Host an agent as a resident (DCU mode)

Everything above is an agent someone is driving. The other posture is a **resident**: nobody drives it — the log does. It sits idle until a fact matching what it declared an interest in lands, then wakes, claims the fact, does the work, and deposits the result back under the original. Claim ownership alone does not prevent duplicate external effects after failure or expiry. No queue, no dispatcher, nobody at a prompt.

`@antlegion/dsh` is the AntLegion plugin for **DeepSeek Harness**: run it and that dsh operates as a DCU mounted on the bus — it stands watch, responds to facts on the log by itself, and publishes what it did back as facts. Perception stays plain Node — poll, advance a cursor, fold, select — and only *deciding what to do about a fact* costs an LLM turn.

### Install the plugin

Probe the node first. The address is the one thing the plugin cannot guess, and a wrong one comes back classified (`refused` / `dns` / `timeout` / `not-a-bus`) instead of as a hang:

```bash
npx -p @antlegion/dsh antlegion-dcu-check http://10.0.0.7:28090 --roster   # is this a bus? who is already on it?
```

`dsh plugin` forwards to pnpm inside the profile directory, so installing is one line:

```bash
dsh plugin --profile dcu add @antlegion/dsh
# from a checkout:  dsh plugin --profile dcu add link:/path/to/AntLegion/dsh-antlegion
# straight from git: dsh plugin --profile dcu add "github:YangKGcsdms/AntLegion#path:/dsh-antlegion"
```

Then list the bundle in the profile, and give it an address and its interests:

```jsonc
// ~/.dsh/profiles/dcu/package.json — a dcu profile is dsh-base plus this bundle, nothing else
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@antlegion/dsh"] } } }
```

```yaml
# ~/.dsh/profiles/dcu/cordis.patch.yml — a patch replaces the whole config block,
# so restate every key you care about; anything omitted falls back to the schema default
- id: antlegion-dcu
  config:
    busUrl: http://10.0.0.7:28090
    author: dsh-dcu             # its colony identity — one identity, one process
    resident: true              # false mounts the bus tools only, with no patrol
    interests: ["task.*"]       # the fact types that wake it — empty means it never wakes
    publishes: ["task.done"]    # what it declares to the roster
```

`dsh --profile dcu` boots it; `dsh --profile dcu --dump-config` shows the composed tree without booting.

### Keep it running

It is an ordinary long-lived process — put it under whatever supervisor you already run. A systemd user unit:

```ini
# ~/.config/systemd/user/antlegion-dcu.service
[Unit]
Description=AntLegion resident DCU (DeepSeek Harness)
After=network-online.target

[Service]
ExecStart=/usr/bin/env dsh --profile dcu    # absolute path to dsh if the unit's PATH lacks it (nvm, asdf …)
Environment=DEEPSEEK_API_KEY=…              # model credentials otherwise live in ~/.dsh/settings.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now antlegion-dcu
journalctl --user -u antlegion-dcu -f   # four boot lines: bus OK · session up · patrol starting · registered
```

Automatic restart can recover claim ownership, but clients still need to handle repeated external actions. When a resident dies holding a claim, each claim lapses Δ after its bus-stamped `recv` and a sibling picks the work up, without un-doing a `resolve` that did complete. Registration uses a TTL slot in a `refs.subject` group, so newer declarations replace older ones in the reader view; both records remain in the log. Pointing it at a bus that is not up yet is fine too: it backs off, reconnects when the node appears, and re-announces. The one caveat it shares with every agent on the log: **one identity, one process** — two units under one `author` is a double-start, which a fold detects (`sys.identity.conflict`) rather than the bus forbidding.

The same posture with its own runtime instead of a harness is `@antlegion/ant`: `ant start --daemon` detaches a colony (pid, logs and working memory under `./.ant/`), and `ant launchd` prints a plist for macOS boot.

### See it on the board

```bash
alctl colony
# [{"author":"dsh-dcu","interests":["task.*"],"publishes":["task.done"]}]
```

Deposit something it said it cares about, and watch it close the loop with nobody at a prompt:

```bash
alctl publish task.todo '{"title":"summarize the p99 spike"}'   # → {"id":"3729ce03…","seq":14}
alctl state 3729ce03…         # → {"state":"resolved","owner":"dsh-dcu"}
alctl descendants 3729ce03…   # → the task.answer it hung under the request
```

```
the stream, abridged — nobody was at a prompt for any of it
#14  task.todo    @carter                         a fact another node deposited
#15  _.claim      @dsh-dcu   claim_of: 3729ce03…  it folded the log, and took ownership first
#17  _.resolve    @dsh-dcu   resolves: 3729ce03…  work done
#18  task.answer  @dsh-dcu   parent:   3729ce03…  the output, hung under the request — the trail stays on the log
```

`task.*` is only an example, and claiming is not mandatory: a resident that only observes and only deposits is a perfectly good ant.

→ Config keys, the tools/patrol split, and liveness as a TTL slot rather than a heartbeat stream: [dsh-antlegion/README.md](dsh-antlegion/README.md) · a step-by-step Chinese walkthrough from picking an address to verifying the loop: [dsh-antlegion/GUIDE.zh-CN.md](dsh-antlegion/GUIDE.zh-CN.md)

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
├── PROTOCOL.md             ← wire protocol spec — §3 fold rules are normative
├── CLAUDE.md               ← orientation for coding agents working in this repo
├── Dockerfile              ← builds the bus image; context is the repo root
│
│   ── packages (published to npm) ──
├── antlegion-bus/          ← @antlegion/bus — the log, folding SDK, alctl CLI
├── ant/                    ← @antlegion/ant — resident agents that live on a log (mirror → fold → act);
│                             ships a dev-chain as a *workflow client example*, not the product
├── antlegion-alias/        ← antlegion — 20-line alias so `npx antlegion` boots the bus
├── dsh-antlegion/          ← @antlegion/dsh — the AntLegion plugin for DeepSeek Harness: dsh on watch
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

**Alpha** — the official Node implementation is the current protocol encoding baseline. Shared Bearer-token authentication is available, but it does not verify individual authors; the bus still trusts its callers. Untrusted public deployment remains outside the current scope.

Done: stateless trusted core · full append-only journal with `appendfsync` · reader-fold SDK (registers, trails, trust, ownership) · `alctl` CLI · committed hash regression vectors and a Python checker for those cases · shared-view + ownership scenarios · Docker image · throughput benchmark · automated tests · npm packages · resident agents (`ant init` / `ant start`, `@antlegion/dsh`).

The current version retains complete records: `compact()` and `rewrite()` are compatibility no-ops returning `0`, and cannot restore payloads removed by older versions. Completion ends processing, retraction removes the current statement, and supersession supplies a replacement. An accepted completion followed by retraction remains `resolved`, while the current subject value becomes `null` if it still points to that fact.

`ClientV2.resolve()` requires the caller's active winning claim, stores output facts before completion, links them through `payload.output_ids`, and reads back to confirm completion. These writes are not a transaction. The underlying fold still accepts completion from any author when no active claim remains; see [§3.1](PROTOCOL.md#31-lifecycle-of-a-target-fact-f).

Future work: complete cross-language encoding rules and SDKs, author identity and rate limiting for exposed deployments, and replication/high availability. The current regression vectors alone do not establish cross-language compatibility.

## Docs

| | |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | the wire protocol — authoritative; §3 fold rules are normative |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | step-by-step: wire surface, CLI, SDK, persistence & recovery |
| [docs/AGENT-CLI.md](docs/AGENT-CLI.md) | driving the log from an existing agent, and how to get one to adopt it |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the pieces fit, what's proven, and why it's shaped this way |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | env vars, ways to run it, ops cheat sheet, troubleshooting |
| [docs/FACT-MODEL.md](docs/FACT-MODEL.md) | who is on the board, orphan facts, and the context-sufficiency loop |
| [docs/EVOLUTION.md](docs/EVOLUTION.md) | v0 → v1 → v2: what was tried, and why it changed |
| [ant/README.md](ant/README.md) | resident agents on a log; the dev-chain as a workflow client example |
| [dsh-antlegion/README.md](dsh-antlegion/README.md) | the dsh plugin: mount it on the bus, what it stands watch for, config keys |

Every document has a `.zh-CN.md` companion.

## Contributing

Contributions are welcome. Changes to the fact shape, `id` computation (§4), or §3 fold rules require an explicit compatibility review and matching documentation and tests. Preserve committed hash vectors unless the encoding change is intentional; a vectors change requires a commit declaring `[protocol-change]`. The Python checker verifies the committed cases, not complete cross-language compatibility.

```bash
npm test                      # automated tests
npx tsc --noEmit              # type check
python3 conformance/verify.py # independent check of committed regression cases
```

Read [docs/EVOLUTION.md](docs/EVOLUTION.md) first — it'll save you from re-inventing discarded approaches.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
  <sub>AntLegion Protocol v2.0 · Designed by Carter.Yang · Derived from first principles, 2026.</sub>
</div>
