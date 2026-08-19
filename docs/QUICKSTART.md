<div align="center">

🌐 **English** · [简体中文](QUICKSTART.zh-CN.md)

</div>

# Quickstart — AntLegion v2

Five minutes from `npx` to two agents — on one machine or two — sharing one
world through immutable facts.

The bus only orders, verifies, stamps, and serves facts. Everything a reader
wants to know — what is X now (`current`), how it came to be (`causation`),
what it led to (`descendants`), trust, and ownership (`claim`/`resolve`) — is a
**reader fold** in the client SDK. See [PROTOCOL.md](../PROTOCOL.md) for the
full spec.

## 1. Run the bus

```bash
npx @antlegion/bus
# [antlegion-v2] append-only fact bus on http://localhost:28090 (fsync=everysec)
```

From source instead:

```bash
cd antlegion-bus
npm install
npm run dev            # or build once and run: npm run build && npm run start
```

Verify it's up:

```bash
curl http://localhost:28090/health
# {"status":"ok","protocol":"2.0","head_seq":0}
```

**Or with Docker** (build from the repo root):

```bash
docker build -t antlegion ..
docker run -p 28090:28090 -e ANTLEGION_BUS_SECRET=your-stable-secret antlegion
```

## 2. The whole wire surface (one write, one read)

```bash
# Append a fact — the bus assigns seq, recv, id, sig
curl -sX POST http://localhost:28090/facts \
  -H 'content-type: application/json' \
  -d '{"type":"demo.hello","author":"me","ts":1748300000,"payload":{"msg":"hi"}}'
# 201 {"seq":1,"recv":1748300000.4,"id":"b3f1…","sig":"…","deduped":false}

# Read from a cursor (git-fetch style)
curl -s "http://localhost:28090/facts?since=0"

# Useful filters
curl -s "http://localhost:28090/facts?since=0&type=task.*"
curl -s "http://localhost:28090/facts?since=0&refs.claim_of=<id>"

# Check the head (start a reader at "newest only")
curl -s http://localhost:28090/facts/head
# {"head_seq":1}

# Bus info (INFO analog)
curl -s http://localhost:28090/info | jq
# {"protocol":"2.0","head_seq":1,"facts":1,"fsync":"everysec","sig_failures":0,…}
```

That is the entire bus API. `claim`, `resolve`, `vote`, `trust`, `state` are
**not** endpoints — they are facts about facts, folded by the client.

## 3. Drive it from the terminal (`alctl`)

`alctl` is the `redis-cli` analog — `npm i -g @antlegion/bus` installs it
(or prefix each command with `npx -y -p @antlegion/bus`). Every command prints
machine-readable JSON on stdout; human errors go to stderr with a non-zero exit:

```bash
# Publish
alctl publish task.build '{"target":"todo-app"}' --author alice
# {"id":"b3f1…","seq":1,"deduped":false}

# Claim (exactly one wins; the loser exits 1)
alctl claim b3f1… --author bob
# {"won":false,"winner":"alice"}

# Check lifecycle state
alctl state b3f1…
# {"state":"claimed","owner":"alice"}

# Resolve — only the claim winner can; anyone else exits non-zero:
#   error: resolve ignored — fact <id> is owned by 'alice' (you are 'bob')
alctl resolve b3f1… --author alice
# {"state":"resolved","owner":"alice"}

# Tail prints the stream once and exits; --follow keeps polling live
alctl tail
alctl tail --follow

# Full bus info (protocol, head_seq, facts, fsync, sig_failures, secret_stable, …)
alctl info
```

`--author <name>` is a global flag on every command that writes facts. Identity
resolution: `--author` > `ANTLEGION_AUTHOR` > `<os-username>@<hostname>` (a
stable per-user default, so a `claim` in one shell command can be `resolve`d in
the next). `ANTLEGION_BUS_URL` picks the bus (default `http://localhost:28090`);
if no bus is listening you'll get
`error: cannot reach bus at <url> — start one with: npm run dev`.

## 4. Coordinate from code (the folding SDK)

`npm i @antlegion/bus`, then:

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
await alice.state(id);  // { state: "resolved", owner: <winner> }
await bob.state(id);    // identical — deterministic fold
```

The client surface: `publish` / `claim` / `resolve` / `release` / `observe` /
`state` / `trustOf` / `causation` / `query` / `snapshot`.

The SDK absorbs the append-then-read-back-and-fold work (PROTOCOL.md §3).

## 5. What makes a fact

```jsonc
{
  "seq":    1,              // bus-assigned (trusted)
  "recv":   1748300000.4,   // bus-assigned trusted time — fold on this, not ts
  "id":     "b3f1…",        // sha256(canonical(record))
  "type":   "build.failed", // dotted; reserved types begin with "_."
  "author": "ci",
  "ts":     1748300000,     // author-stated (advisory only)
  "payload": { "…": "…" },
  "refs": {                 // always fact ids, never agent ids
    "parent":    "<id>",    // causal predecessor
    "claim_of":  "<id>",    // exclusive claim on target
    "resolves":  "<id>",    // target is done
    "vote":      "<id>",    // corroborate / contradict
    "supersedes":"<id>",    // this replaces target
    "tombstones":"<id>"     // target is deleted/GC'd
  }
}
```

## 6. Connect an agent (the `alctl` CLI)

A headless or PI agent (Claude Code, Cursor, Codex CLI, a shell tool, a cron
job) drives the bus by shelling out to `alctl` — the same verbs as §3, one fold
call each. Give it a bus URL and a stable identity:

```bash
export ANTLEGION_BUS_URL=http://localhost:28090   # default
export ANTLEGION_AUTHOR=my-agent                   # or --author per call

# the agent loop: read since a cursor, claim exactly-once, resolve
alctl read --type 'task.*' --since "$CURSOR"
alctl claim <id> && alctl resolve <id>
alctl publish task.done '{"result":"ok"}' --parent <id>
```

`alctl claim` exits 0 only for the single winner, so an agent branches on the
exit code and never double-executes. See [AGENT-CLI.md](AGENT-CLI.md) for the
full agent guide (verb ↔ fold map, the `sys.registry` fact, crash recovery).

## 7. Validate the multi-agent swarms

```bash
# 21 agents, 50-item fan-out/in, exactly-once (dupes=0 missing=0)
npx tsx examples/swarm-v2.ts

# Crash + claim-timeout re-dispatch
npx tsx examples/scenario-resilience.ts

# Peer review: decider acts only on consensus
npx tsx examples/scenario-consensus.ts

# Causal pipeline build→test→deploy + supersession
npx tsx examples/scenario-pipeline.ts
```

Each example self-boots its own bus on an ephemeral port — no bus needed beforehand.

## 8. Persistence and recovery

The bus writes a single `facts-v2.jsonl` file in `ANTLEGION_DATA_DIR` (default `.data-v2`).
Kill and restart it with the same `ANTLEGION_BUS_SECRET` — it recovers completely:

```bash
# Start, write some facts, stop
ANTLEGION_BUS_SECRET=stable node dist/index.js &
curl -sX POST http://localhost:28090/facts \
  -H 'content-type: application/json' \
  -d '{"type":"t","author":"u","ts":1,"payload":{}}'
kill %1

# Restart — head_seq is restored, sig_failures=0
ANTLEGION_BUS_SECRET=stable node dist/index.js &
curl -s http://localhost:28090/info | jq '.head_seq, .sig_failures'
# 1
# 0
```

Compaction (the BGREWRITEAOF analog):

```bash
curl -sX POST http://localhost:28090/admin/rewrite | jq
# {"stripped": 0}   # payloads dropped from tombstoned/superseded facts
```

## Where to go next

- [PROTOCOL.md](../PROTOCOL.md) — the full v2 spec (§3 fold rules are normative).
- [EVOLUTION.md](EVOLUTION.md) — why the project looks like this.
- `antlegion-bus/src/` — core (`bus.ts`), wire (`server.ts`), folds (`fold.ts`), SDK (`client.ts`).
- `antlegion-bus/conformance/` — cross-language interop vectors + Python verifier.
- `antlegion-bus/test/` — 147 tests (vitest).
