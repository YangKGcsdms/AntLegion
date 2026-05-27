<!-- lang-nav --> 🌐 **English** · [简体中文](QUICKSTART.zh-CN.md)

# Quickstart — AntLegion v2 (append-only fact bus)

Five minutes from clone to two agents coordinating through immutable facts.
v2 is the [first-principles redesign](PROTOCOL.md): the bus only orders, verifies,
stamps, and serves facts; all coordination is a **reader fold** in the client SDK.

## 1. Run the bus

```bash
cd antlegion-bus
npm install
npm run dev:v2          # tsx src/v2/index.ts — http://localhost:28090
#   or: npm run build && npm run start:v2
```

Verify:

```bash
curl http://localhost:28090/health
# → {"status":"ok","protocol":"2.0","head_seq":0}
```

## 2. The whole wire surface (one write, one read)

```bash
# append a fact (the bus assigns seq, recv, id, sig)
curl -sX POST http://localhost:28090/facts \
  -H 'content-type: application/json' \
  -d '{"type":"demo.hello","author":"me","ts":1748300000,"payload":{"msg":"hi"}}'
# → 201 {"seq":1,"recv":...,"id":"…","sig":"…","deduped":false}

# read from a cursor (git-fetch style)
curl -s "http://localhost:28090/facts?since=0"
```

That is the entire bus API. `claim`, `resolve`, `vote`, `trust`, `state` are
**not** endpoints — they are facts about facts, folded by the client.

## 3. Coordinate from code (the folding SDK)

```ts
import { ClientV2, httpTransport } from "antlegion-bus/v2/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

const { id } = await alice.publish("task.build", { target: "todo-app" });

// both race; exactly one wins (lowest seq — a theorem of total order)
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]);
const winner = ra.won ? alice : bob;

await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);

await alice.state(id);  // → { state: "resolved", owner: <winner> }
await bob.state(id);    // same — any client folds the same state from the log
```

The client surface stays as small as v1's MCP tools
(`publish / claim / resolve / release / observe / state / trustOf / causation`);
the SDK absorbs the append-then-read-back-and-fold work (PROTOCOL.md §3).

## 4. What makes a fact

```jsonc
{ "type": "build.failed", "author": "ci", "ts": 1748300000,
  "payload": { "...": "..." },
  "refs": { "parent": "<id>", "claim_of": "<id>", "vote": "<id>", "supersedes": "<id>" } }
```

`refs` is the only relational mechanism. Reserved fact types `_.claim`,
`_.resolve`, `_.release`, `_.vote`, `_.tombstone` carry the coordination verbs.

## Where to go next

- [PROTOCOL.md](PROTOCOL.md) — the v2 protocol, derived from one primitive.
- `antlegion-bus/src/v2/` — core (`bus.ts`), wire (`server.ts`), folds (`fold.ts`), SDK (`client.ts`).
- `antlegion-bus/test/v2/` — core / lifecycle / trust+causation / server / client / e2e.

## Status

Alpha. Reachable but not yet built: a v2 MCP adapter (N3), cross-language
conformance vectors (N6), and public-facing auth/rate-limit hardening (N7).
