# Closing the fact-model loop — interests, orphans, and context

🌐 **English** · [简体中文](FACT-MODEL.zh-CN.md)

The bus gives you an immutable, ordered stream of facts and a handful of folds
(lifecycle, trust, causation). That is enough to *coordinate*, but it leaves
three questions a running colony keeps asking that a bare log can't answer:

1. **What does each agent actually care about, and what does it emit?** — the
   loop between an agent's *interests* and its *publishes* was implicit.
2. **Is anyone listening?** — a fact can be published into the void with no
   agent set up to consume it (an *orphan*), and nothing flags it.
3. **Is this fact even actionable?** — a fact may say "X is broken" without
   enough context for the agent that cares to decide anything.

All three are solved **additively**, as conventions folded from the same
primitive — no new wire op, no change to the §3.1–§3.4 folds, no change to the
§4 conformance vectors. See `PROTOCOL.md` §3.5–§3.6 for the normative summary.

---

## 1. Agents declare interests + publishes (`sys.registry`)

On startup an agent announces itself with one fact:

```json
{
  "type": "sys.registry",
  "author": "planner",
  "payload": {
    "interests": ["req.*", "task.*"],   // fact-type globs it consumes/claims
    "publishes": ["plan.ready"]          // types it emits
  }
}
```

`interests`/`publishes` are the **general** capability declaration. The
dev-chain's stage DCUs already had the shape (`listens`/`produces`); those are
still read as a fallback, so nothing regressed — but every agent now speaks the
same vocabulary, and the loop between "what I listen for" and "what I produce"
is explicit and foldable.

```bash
alctl publish sys.registry '{"interests":["task.*"],"publishes":["task.done"]}' --author planner
alctl colony        # → the live roster, latest registration per agent
```

`colony(stream)` keeps the **latest** registration per author (re-registering
updates in place — same latest-wins idea as supersession).

## 2. Orphan facts + declaration gaps

`orphanReport(stream)` folds the roster against the actual stream and surfaces
three coordination gaps:

| gap | meaning |
|---|---|
| **orphan type** | a fact type in the stream that **no** agent's `interests` glob matches — output nothing is set up to consume |
| **unmatched interest** | an agent declares interest in a type that **never appears** — it's waiting on silence |
| **silent publish** | an agent declares it `publishes` a type it **never actually emitted** |

Mechanical/convention types are excluded — nobody "declares interest" in a
claim: `_.*` (claim/resolve/release/vote/tombstone), `sys.*` (registry), and
`context.*` (§3 below — `contextGaps` already tracks whether a request was
answered, which is a strictly better signal than "no declared interest").

```bash
alctl orphans       # → { orphanTypes, unmatchedInterests, silentPublishes, registeredAgents }
```

The console's **舰群 / colony** tab renders this live and raises a banner when
orphans exist — a supervisor sees "4 fact types with no interested agent"
without reading the log. With **zero** registrations the report says so
(`registeredAgents: 0`) rather than pretending every type is fine.

## 3. Context-sufficiency loop (when a fact is too thin)

The hard case the model didn't answer: an agent claims/reads a fact, and finds
it **insufficient to judge** — "build.failed: it broke" tells you nothing
actionable. Silently dropping it loses the signal. The loop:

```
build.failed  (author: ci, payload: {note: "it broke"})
   ▲ refs.about
context.requested  (author: dev, payload: {question: "which target? what error?"})
   ▲ refs.parent / refs.answers
context.provided   (author: ci, payload: {answer: "arm64, linker undefined symbol"})
```

- The interested agent doesn't guess and doesn't give up — it publishes a
  `context.requested` naming the thin fact (`refs.about`) and its question.
- Whoever can answer (often the original author) replies with
  `context.provided` linked back (`refs.parent` or `refs.answers`).
- `contextGaps(stream)` lists requests **still unanswered** — the console
  surfaces them under **待补充上下文 / context needed**, and they clear the
  moment an answer lands.

```bash
alctl ask-context <thin-fact-id> "which target and what error?"   --author dev
alctl provide-context <request-id> '{"answer":"arm64, linker error"}' --author ci
alctl context-gaps   # → open (unanswered) requests
```

### Why a fact, not a richer schema?

We deliberately did **not** bolt a mandatory "context" schema onto every fact.
Two reasons: (1) it would be a wire change touching the §4 vectors, and (2) most
facts are fine as-is — forcing a context block on all of them taxes the common
case to serve the rare one. The request/response *convention* keeps the core
minimal while making "this isn't enough, I need more" a first-class, auditable
move in the same fact stream. A fact **may** still carry context proactively
(`refs.parent` to its source, a `context` field in the payload); the loop is the
safety net for when it didn't.

---

## Where it lives

- `antlegion-bus/src/fold.ts` §7/§8 — `colony`, `orphanReport`, `contextGaps`
  (pure, additive; unit tests in `test/fold-colony.test.ts`).
- `antlegion-bus/src/cli.ts` — `colony`, `orphans`, `ask-context`,
  `provide-context`, `context-gaps` verbs.
- `antlegion-bus/console/console.html` — the **舰群** tab (bilingual), same
  logic ported inline (as the lifecycle badge already is).
- `ant/src/dcus/*` — the dev-chain fleet now declares `interests`/`publishes`.
