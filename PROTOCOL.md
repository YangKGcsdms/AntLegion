<div align="center">

🌐 **English** · [简体中文](PROTOCOL.zh-CN.md)

</div>

# AntLegion Protocol — v2.0

> One primitive. One write. One read. Everything else is derived.
>
> **A shared world-state log for agents that share nothing else.**
>
> Designed by **Carter.Yang**. Re-derived from first principles, 2026.

The key words **MUST**, **MUST NOT**, **SHOULD**, **MAY** are per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 0. The derivation (why v2 looks like this)

### 0.0 What this is for

Two agents that share **nothing** — not a process, not a machine, not a
vendor, not a memory — need to agree on what is true. Not on what to do:
each decides that alone. On the *world*: what happened, what the current
value of X is, how it came to be, what it led to, and whether it can be
trusted. Today the medium between such agents is a human pasting state from
one window into another.

This protocol is that medium. It is a **shared world-state log**: every agent
deposits what it observed, and every agent — at its own pace, on its own
node — derives state from a totally-ordered, append-only, content-addressed
log using reader folds (§3). Readers agree when the log position, fold rules,
parameters, and calculation time are the same. "Facts, not commands" describes
the bus: it does not address, dispatch, or force an agent to execute anything.
Arbitrary JSON can contain instruction-like text; the bus does not interpret it.

Everything a workflow engine or an orchestrator does is *out of scope*: this
protocol has no steps, no assignments, no scheduler. It has one derived
consequence that looks like coordination — ownership of a fact is itself a
piece of world state, and total order makes it unambiguous (§3.1) — but that
is a corollary of sharing a world, not the purpose.

### 0.1 The single primitive (一元论)

There is exactly one kind of thing in this system:

> **A Fact: an immutable, content-addressed statement, placed at a unique
> position in a single total order.**

That is the whole ontology. A fact is a unit of shared world state — a
statement about the world. The bus does not execute or dispatch its content. There are no
separate "tasks," "claims," "votes," "trust levels," or "states." Those words
name *patterns of facts* — a fact is all there is. This is the monist move,
and every rule below is a *consequence* of it, not an addition to it.

Two operations act on the primitive, and only two:

- **append(fact) → seq** — add a fact; the bus assigns it the next position in
  the total order.
- **read(since_seq) → fact[]** — return facts after a position, in order.

### 0.2 What the bus is (and is not)

From the primitive, the trusted core that the bus MUST provide is small and
fixed:

1. **Order** — assign a strictly increasing `seq`. This total order is the
   bus's *only* authority.
2. **Integrity** — verify `id == hash(record)`; reject mismatches.
3. **Durability** — append to a log that survives restart.
4. **Range read** — return `seq > since` in order.

The bus has **no mutable per-fact state**, no state machine, no claim table, no
trust computation, no dispatch, no arbitration, no push. It is a *verifiable,
totally-ordered, append-only log* — the smallest object on which the rest can
be derived. (Compare: a single signed Kafka partition, or git with a sequence.)

> **Axiom of non-adjudication.** The bus orders and preserves facts. It never
> decides what they *mean*. Meaning is computed by readers (§3). This is why
> trust, lifecycle, and exclusivity are reader folds, not server state.

### 0.3 Everything else, derived

Every question a reader asks about the shared world is a fold over the same
stream. In the order a physically isolated agent needs them:

| question / v1 concept | v2 derivation |
|---|---|
| **what is X right now** (`supersedes` / auto-supersede index) | a fact carries `subject` and/or `supersedes`; the reader keeps the highest `seq` per subject — a **register** folded identically on every node (§3.3) |
| **how did this come to be / what did it lead to** (`causation_chain` + `causation_depth`) | walk `parent` links backward (chain) or forward (descendants); depth is computed, not stored (§3.4) |
| **can it be trusted** (`epistemic_state` + quorum config) | a **fold** over `vote` facts; quorum is the *reader's* policy (§3.2) |
| **who owns it** (`published/claimed/resolved/dead`) | a **fold** over claim/resolve/tombstone facts referencing the target (§3.1) |
| atomic `claim` endpoint + arbitration | append a `claim` fact; **lowest `seq` active claim on the target wins** — ownership is world state; this does not guarantee exactly-once external actions |
| TTL → `dead` transition | reader-side filter; never a server state change or deletion |
| acceptance filter / dispatch | reader-side query predicate (server MAY offer it as a pure read optimization) |
| event push / WebSocket | removed; read advances the cursor |
| `semantic_kind`, `schema_version`, `priority`, `confidence`, TEC, reliability | optional payload/ref hints; **none** are interpreted by the trusted core |

The fact's wire shape shrinks from ~30 fields to a handful (§1). The two
server state machines disappear. The "smart" logic moves into one shared
**client fold library** (§3), shipped once per language instead of
re-implemented inside every bus.

**Where the elegance goes.** v1's MCP adapter stayed elegant by *forwarding*
(call `/claim`, get 200/409). Under v2 the adapter must *fold* (append a claim,
read back to confirm, project state/trust). The client-facing surface — e.g.
the `alctl` CLI's verbs — can stay exactly as simple, but only because the adapter / fold
library now absorbs that work. v2 makes the **bus** trivial and the **adapter**
slightly heavier; a raw client that skips the adapter trades a single
round-trip for append-plus-fold. This is a deliberate relocation of complexity
to the one place it can be written once and conformance-tested — not a deletion.

---

## 1. The Fact

```jsonc
{
  "seq":     1337,                  // bus-assigned position in the total order. Absent until appended.
  "recv":    1748300000.4,          // bus-assigned TRUSTED receive time (unix s). Set by bus. Time-based folds use THIS.
  "id":      "b3f1…",               // = hash of the canonical record (§4). Content address. MUST.
  "type":    "build.failed",        // dotted taxonomy. MUST.
  "author":  "claude-code",         // who appended it. MUST.
  "ts":      1748300000.0,          // unix seconds, author-stated. ADVISORY only (spoofable). MUST.
  "payload": { "...": "..." },      // plain JSON object; omitted input defaults to {}.
  "refs":    { "...": "..." },      // relations and subject name; omitted input defaults to {}.
  "nonce":   "k7…",                 // optional uniqueness token: a legitimate repeat (e.g. re-claim) gets a distinct id (§4). MAY be absent.
  "sig":     "hmac…"                // bus signature over (id, author, type, ts, recv, seq). Set by bus.
}
```

`refs` carries relationships. **`refs.subject` is a subject name**; the other
defined keys below reference **fact ids**. Unknown extension keys are accepted
as strings and do not introduce bus-side dispatch. These field conventions do
not prevent a payload or an extension from containing an agent name or an
instruction. Defined keys:

| `refs` key | Value | Meaning (a reader fold interprets it) |
|---|---|---|
| `parent` | fact id | This fact was caused by that one. Causation = transitive `parent` (§3.4). |
| `subject` | string | Names the piece of the world this fact is about; the group key for the latest-wins **register** (§3.3). |
| `supersedes` | fact id | The target is **replaced by a successor** (this fact). |
| `tombstones` | fact id | A `_.tombstone` marks the target **retracted** — distinct from `supersedes`, which means *replaced*. Folds MUST tell the two apart (§5.2). |
| `vote` | fact id | Combine with `payload.verdict ∈ {corroborate, contradict}` (§3.2). |
| `claim_of` | fact id | Author asserts exclusive responsibility for the target (§3.1). |
| `resolves` | fact id | The target is considered handled; payload MAY carry the result. |
| `release_of` | fact id | Author abandons a prior claim. |
| `about` | fact id | `context.requested`: the fact found too thin to act on (§3.6). |
| `answers` | fact id | `context.provided`: the `context.requested` it answers (§3.6). |

A bus MUST accept unknown `refs` keys (forward compatibility) and MUST NOT
interpret them — only readers do. The trusted core looks at `refs.parent` *only*
to enforce the one structural safety rule (§5, depth/cycle), nothing else.

**`ts` vs `recv`.** `ts` is what the author *claims* the time was; it is part of
the content hash and is **advisory** (a skewed or hostile clock can set it
anywhere). `recv` is what the bus *witnessed*, is signed, and is **trusted**.
Every time-based fold (claim-timeout §3.1, TTL) MUST key on `recv`, never `ts`
— otherwise different readers reach different conclusions and the fold stops
being deterministic. `seq` and `recv` are the bus's two trusted stamps: `seq`
for order, `recv` for time.

Everything removed from v1's fact (state, claimed_by, corroborations[],
effective_priority, …) is now **derivable** and therefore MUST NOT be stored on
the fact. `priority`, `confidence`, `ttl`, `semantic_kind` etc. — if a use case
wants them — live in `payload` and are honored only by readers that care.

---

## 2. Bus operations (the entire wire surface)

### 2.1 Append

```
POST /facts
  { type, author, ts, payload?, refs?, nonce?, id? }
→ 201 { seq, id, sig }            // id/sig echoed; id MAY be sent as "" for the bus to compute
→ 409 { error: "id mismatch" }    // integrity failure
```

Append is the only write. The bus assigns `seq`, verifies/derives `id`, signs,
persists, returns. No mode, no token-gated claim, no priority. (Auth, if any, is
a transport concern — see §6.) Public entry points normalize and copy the
input before hashing or storing it (§4); both operations use the same
normalized content. Mutating the caller's object afterwards MUST NOT change a
stored fact.

### 2.2 Read

```
GET /facts?since=<seq>&limit=<n>&type=<glob>&author=<id>&refs.<key>=<id>
→ 200 [ fact… ]                   // ascending by seq
   header: X-Max-Seq: <highest seq returned>
```

`since` is the cursor: pass back the previous `X-Max-Seq` to get only new facts.
This is the *canonical* access pattern — closer to `git fetch` than to a queue.
All query parameters are **pure filters over the same totally-ordered stream**;
they change which facts are returned, never their meaning or order. A minimal
conforming bus MAY ignore every filter except `since`/`limit` and remain
correct — filters are an optimization, the fold (§3) is the semantics.

```
GET /facts/head → { head_seq }    // start a fresh reader at "newest only"
GET /facts/<id> → fact            // fetch one by content address
```

That is the complete bus API: **one write, one read, two read conveniences.**

---

## 3. Reader folds (where meaning lives)

A reader replays facts in `seq` order and folds them into whatever projection
it needs. These fold rules are **normative** — conformance lives here, not in
the bus. Agreement requires the **same log position, fold rules, parameters,
and calculation time**. A live reader may be ahead of another; trailing claim
expiry depends on `now`; trust thresholds are reader policy (§3.2). Differences
in those inputs can legitimately produce different answers.

The folds answer four questions about that world. Ownership (§3.1) is listed
first because its rule is the longest, not because it is the most important;
a stream with no `_.claim` in it is a perfectly good world (see
`examples/scenario-shared-view.ts`).

| question | fold |
|---|---|
| who owns F, if anyone | lifecycle §3.1 |
| can F be trusted | trust §3.2 |
| what is X right now | subject register §3.3 |
| how did F come to be · what did F lead to | causation §3.4 |

### 3.1 Lifecycle of a target fact `F`

Scan all facts whose `refs` point at `F`:

Fold the facts referencing `F` in `seq` order, maintaining the set of **active
claims** (claims not yet released or expired). **`resolved` and `dead` are
terminal** — decided when their fact appears and never revisited:

```
fold(F):
  active ← []                       # claims still holding F, each = {author, seq, recv}
  for fact in (facts referencing F, ascending seq):
    if tombstone(F)                       → return dead                       # terminal
    active ← [c ∈ active where fact.recv ≤ c.recv + Δ]   # deterministic expiry, anchored on recv
    if fact.refs.claim_of   == F          → active.push(fact)
    if fact.refs.release_of == F          → drop fact.author from active
    if fact.refs.resolves   == F:
        owner ← lowest-seq author in active (or null)
        if fact.author == owner or owner == null  → return resolved(owner)    # terminal
  active ← [c ∈ active where now ≤ c.recv + Δ]           # trailing expiry vs wall clock
  return active ? claimed(lowest-seq author in active) : open
```

**Why recv-anchored expiry.** A claim times out (the crash-recovery path) when
time has provably advanced past `claim.recv + Δ`. Wherever a *later fact*
exists, that proof is the later fact's own bus-stamped `recv` — identical for
every reader, so the fold is **deterministic**. Only a *trailing* claim with no
successor falls back to wall-clock `now`, and that only affects the advisory
"should a new claimant try?" hint, never a terminal decision.

This is what makes crash recovery correct in both directions:
- A `resolve` issued *before* its claim expires is honored and terminal forever
  — timeout (a crash-recovery mechanism) never undoes a real completion.
- A claim that *did* time out is expired by the recv of the next claim, so the
  **re-dispatched** agent becomes the legitimate owner and *its* resolve is
  honored. (A naive "owner = first claimer, releases only" rule is wrong: a
  crashed claimer's stale claim would block the recovering agent's resolve, and
  the item would be re-done forever.)

**Ownership is world state.** Among active claims on `F`, the claim with the
**lowest `seq` wins**. Readers using the same inputs (§3) compute the same
owner. This is a statement about ownership in the log, not exactly-once
execution of an external action. A process can act and fail before recording
completion, or continue acting after its claim expires; clients must handle
external retries and duplicate effects. No atomic
endpoint, no leader election, no hot-path arbitration. A claimer confirms it won
by reading `F`'s claim set back and seeing no live `claim_of: F` at a lower
`seq`; to keep that O(claims-on-F) instead of O(log), a bus SHOULD support the
`?refs.claim_of=<id>` filter (§2.2). Timeout-based release is deterministic
**only because it keys on the bus-stamped `recv`**, not the author's `ts`; a
`release_of` by the claim's author ends the claim immediately regardless of Δ.

**Fold rule and SDK policy differ.** The normative fold honors `resolves: F`
from the current active claim winner, or from **any author when no active claim
remains**, including after release or expiry. It ignores a different author
while an active owner exists. The official Node SDK is stricter:
`ClientV2.resolve()` requires the caller to hold the active winning claim.

The SDK writes output facts first, then appends completion with their ids in
`payload.output_ids`, and reads back to verify that completion was honored.
These appends are **not a transaction**: an error can leave outputs without
completion, or a stored completion whose read-back could not be confirmed.
`resolved` means processing ended; it does not mean a subject value changed or
that an external action succeeded exactly once. A later tombstone leaves the
earlier lifecycle result `resolved`, while `current(subject)` becomes `null`
if that fact is still the subject's current statement (§5.2).

### 3.2 Trust of a fact `F`

Fold `vote` facts referencing `F`. A reader MUST ignore self-votes
(`vote.author == F.author`) and MUST count only each author's **latest** vote
(highest `seq`), so a voter who changes their mind is never double-counted:

```
trust(F, quorum):                       // quorum is the READER'S choice, default 2
  C = authors whose latest vote = corroborate
  X = authors whose latest vote = contradict
  if superseded(F)         → superseded  // freshness beats confidence
  elif |X| ≥ quorum        → refuted
  elif |X| > 0             → contested
  elif |C| ≥ quorum        → consensus
  elif |C| > 0             → corroborated
  else                     → asserted
```

The bus stores none of this. Different readers MAY pick different quorums —
the bus does not adjudicate truth (§0.2). Trust **does not** propagate to
descendants automatically; a reader that cares about a chain's validity walks
`parent` and checks ancestors itself.

**Trust has no global value, so never coordinate on it.** Because quorum is the
reader's choice, two readers can legitimately disagree on whether `F` is
`refuted` or `consensus`. Any decision that all participants must agree on — who
does the work, whether to proceed — MUST be built on exclusive claim
with the same log position, expiry parameters and calculation time (§3.1). Trust is
for *advice and triage*, not for arbitration.

### 3.3 Supersession — the subject register ("what is X right now")

A `refs.subject` names a piece of the world: `deploy:prod`, `schema:orders`,
`belief:customer-42:churn-risk`. Every fact carrying that subject is a
statement about it; together they form the subject's **register**. The
register is how a value that keeps changing is shared between isolated agents
without anyone holding it — nobody stores "the current value", every reader
folds it:

```
history(S) = facts with refs.subject == S, ascending seq        # all that was ever said about S

current(S):
  if history(S) is empty                → null                  # nobody has said anything
  cur ← highest-seq fact in history(S)                          # latest-wins within the group
  while ∃ fact x with x.refs.supersedes == cur.id:              # explicit replacement wins over group order
      cur ← highest-seq such x                                  #   (x need not carry the subject)
  if ∃ _.tombstone with refs.tombstones == cur.id → null        # retracted: gone, NOT the previous value (§5.2)
  return cur

supersededBy(F) = the highest-seq explicit `supersedes: F` if any,
                  else the highest-seq newer fact in F's subject group, else null
```

Every reader that folds `current(S)` with the same rules through the same log
position gets the same fact, including after replay. That is what makes a
register a *shared* register. It is also the reason `refs.subject` is a plain
string chosen by the writer: two agents that have never met can write to the
same piece of the world by agreeing on a name.

Latest-wins is a *reader policy*, and this fold is one policy: a reader
accumulating multi-source observations reads `history(S)` and does not
collapse it. (v1's auto-supersede footgun is gone — there is no server index
silently replacing facts.) Retraction is deliberately not "roll back to the
previous value": a tombstoned register answers *nothing is known*, because a
reader that resurrected an older statement would be asserting something no
author currently asserts.

### 3.4 Causation — the trail

`chain(F)` = follow `refs.parent` transitively to a root, returned root→F:
*how did F come to be*. Depth = chain length.

`descendants(F)` = every fact whose `parent` chain leads back to F,
transitively, in `seq` order (F excluded): *what did F lead to*.

Both are pure folds over the same stream, so a reader on another node
reconstructs the same trail through the same log position. Facts are immutable
and retained in full; an explicit `tombstone` retracts a statement without
removing its record (§5.2). A reader can still inspect a retracted ancestor. And
because `id` is a content hash (§4), a `parent` link cannot be forged after the
fact and a cycle cannot be constructed at all (§5) — the trail is provenance
that holds across organizational boundaries without anyone vouching for it.

### 3.5 Colony registry & orphan facts (optional convention)

When the agents on a bus are physically isolated, "who is here, listening for
what, producing what" is itself a piece of world state nobody can see
directly. This convention makes it foldable.

Nothing above requires an agent to announce itself — coordination is stigmergic.
But a supervisor often wants to close the loop between *what an agent listens
for* and *what it publishes*, and to notice work that no one is set up to
consume. This is a **convention layered on the same primitive**, not new wire
mechanics: an agent publishes a `sys.registry` fact declaring
`interests` (fact-type globs it consumes) and `publishes` (types it emits);
readers fold those declarations against the stream.

- `colony(stream)` = latest `sys.registry` per author → the live roster.
- A fact type is an **orphan** when no registered agent's `interests` glob
  matches it — output nothing is set up to consume. `orphanReport(stream)` also
  surfaces two reverse gaps: an `interest` matching no fact in the stream (an
  agent waiting on silence), and a declared `publishes` type its author never
  actually emitted (a silent producer).
- Mechanical/convention types (`_.*`, `sys.*`, `context.*`) are excluded from
  orphan analysis — they are protocol machinery, not un-consumed domain work
  (`context.*` has its own, better signal in §3.6).

This is **purely additive**: it introduces no reserved fact type (`sys.registry`
is an ordinary dotted type), changes no fold in §3.1–§3.4, and does not affect
the §4 conformance vectors. An implementation may ignore it entirely.

### 3.6 Context-sufficiency loop (optional convention)

A fact may assert "X is broken" without enough context for the agent that cares
to act. Rather than dead-ending, the interested agent publishes a
`context.requested` fact (`refs.about` = the thin fact, `payload.question`), and
any agent able to answer replies with `context.provided`
(`refs.parent`/`refs.answers` = the request, `payload.answer`).
`contextGaps(stream)` folds out the requests still unanswered, so a human or
another agent can close the loop. Also additive; also outside the §4 vectors.

See `docs/FACT-MODEL.md` for the full rationale and worked examples.

---

## 4. Identity & integrity

The official Node implementation in `antlegion-bus/src/canonical.ts` and
`hash.ts` is the current encoding baseline. `id = sha256(canonical(record))`.
The content record contains `type`, `author`, `ts`, `payload`, nonempty `refs`,
and a nonempty `nonce` when supplied. `seq`, `recv`, `sig`, and `id` itself are
excluded. Existing ordinary JSON event encodings and committed hash vectors
remain unchanged; this is **not a claim of Python-compatible encoding or full
cross-language conformance**. One compatibility correction is explicit: an own
`__proto__` key, previously omitted by canonicalization, now participates in
the hash. Inputs containing that key can therefore get a different id; the
ordinary committed vectors remain unchanged.

Public append and hash entry points MUST normalize and copy the input first.
`type` and `author` are nonempty strings; `ts` is a finite number. `payload`
is a plain JSON object (omission defaults to `{}`), containing only JSON
objects, arrays, strings, finite numbers, booleans, and `null`. Non-JSON values
such as `Date`, functions, `BigInt`, non-finite numbers, cyclic objects and sparse
arrays are rejected rather than silently coerced. Object content consists of
its enumerable string-keyed fields, as in JSON. Omitted or top-level
`undefined` payload/refs use their defaults;
`null` payload/refs are rejected. `refs` must be a plain object and defaults
to `{}`; values must be
strings, with empty strings and omitted/`undefined` references removed; a
`null` reference is rejected. `nonce` is an optional string; an empty string
is treated as omitted. The hash excludes empty `refs` and an omitted `nonce`,
preserving the existing encoding. The normalized content
used to hash MUST also be the content stored. Unknown top-level fields,
including supplied `seq`, `recv`, and `sig`, do not become content fields.

**Append is idempotent by `id`, not by business intent.** Appending the same
normalized content returns the existing `{seq, recv, sig}` without a second
record. A retry MUST reuse the complete original input, including `ts` and
`nonce`. Calling a helper again with a fresh timestamp or nonce can create a
new fact. A genuinely new action, such as a later re-claim, SHOULD use a fresh
`nonce`; reuse it only when retrying that same append.

The bus signs every accepted fact: `sig = hmac_sha256(secret, "id|author|type|ts|recv|seq")`.
A verifier recomputes that HMAC and compares (constant-time) to `sig`; because
the key is symmetric, **only a holder of the secret can verify** — the bus on
recovery (a failing `sig` means the log was tampered or written under a
different secret), or a read-replica that shares the secret. An unauthenticated
HTTP reader cannot verify `sig`; for it, the content address `id` is the
integrity check, and `seq`/`recv` are trusted by trusting the bus.
Operators MUST set a stable `ANTLEGION_BUS_SECRET` so signatures verify across
restarts. `conformance/vectors.json` is a committed **regression corpus** for
existing encodings. `conformance/verify.py` checks those cases independently;
passing them does not prove compatibility for every JSON value, key order, or
number representation. A future cross-language specification requires its
own complete encoding rules and validation.

---

## 5. The only safety rules the bus enforces

Kept deliberately minimal: just enough to stop an append-only log from being
weaponized into unbounded growth or cycles. Everything else is a reader concern.

1. **Integrity** — reject `id` ≠ `hash(record)` (§4).
2. **Causation depth** — reject if causation depth (computed by walking
   `parent`) exceeds a configured max (default 64). A `refs.parent` **cycle is
   structurally impossible** under content addressing — closing a loop A→B→A
   would need A's `id` (and thus A's frozen content, which already names B) to be
   known before A is hashed, i.e. a sha256 pre-image — so only depth is
   enforceable, and the depth walk always terminates.
3. **Admission rate** — a bus MAY apply a per-author token bucket and a global
   rate cap to bound log growth. Rejections are facts-not-written, never state
   mutations.

### 5.2 Retraction is a fact

The bus never edits or deletes a stored fact. `_.tombstone` with
`refs.tombstones` retracts a statement; `supersedes` identifies its replacement;
`resolves` records that processing ended. These are separate meanings. A
retracted current subject statement returns `null`, without restoring an older
value. Lifecycle remains at its first accepted terminal result: a tombstone
before completion yields `dead`; a tombstone after an accepted completion
leaves lifecycle `resolved`. Trust follows §3.2 and does not gain a separate
`dead` state from retraction.

This version retains **complete records, including payloads**. Vote verdicts
and other reader semantics depend on payload data, and removing it would also
prevent recomputation of the original content hash. `compact()` and `rewrite()`
remain compatibility entry points but do nothing and return `0`; they do not
remove payloads or rewrite the journal. Data removed by an older version's
compaction cannot be reconstructed from the remaining log (§7).

---

## 6. Auth (transport-layer, optional)

v1 baked tokens into claim/resolve. v2 removes per-operation auth from the
semantics: since exclusivity is decided by `seq` order and *who* claimed is just
`author`, authentication is purely about "is this author who they say." That is
a **transport concern** (mTLS, a gateway, an API key header), out of scope for
the fact model. A deployment MAY run the bus open (trusted network) or behind
an authenticating proxy that stamps/validates `author`. The protocol does not
mandate a scheme, but a public deployment SHOULD authenticate `author` and
SHOULD NOT expose write access unauthenticated. The Node implementation
supports `ANTLEGION_API_TOKEN`, a shared HTTP Bearer token. It controls access
but does not bind the supplied `author` to a verified identity.

---

## 7. Storage & recovery

The bus is an append-only log (one JSON record per line, fsync per append or
per batch). Recovery: read the log in order; on a torn final record, truncate to
the last byte offset that parses, then resume appending. There is **no
in-memory state machine to rebuild** — the log *is* the state, and `seq` is
restored from the last record. This is the reliability dividend of §0.2.

The current version keeps the full log. `compact()`, `rewrite()`, and
`POST /admin/rewrite` retain their callable interfaces but perform no deletion
or file rewrite; the HTTP response reports `stripped: 0`. This preserves
payload-dependent folds and content-hash verification. Previously compacted
records remain missing their original payloads; restoring them requires a
complete backup, not another replay or rewrite.

**Total order ⇒ a single logical appender.** `seq` is one global sequence, so
all writes funnel through a single logical append point. High availability is
therefore *single-writer with failover* (e.g. Raft replicating the append
position), **not** multi-master — there is no way to merge two independent
orders while preserving the original ownership order (§3.1). Reads scale out freely
across log replicas. A deployment that genuinely needs multi-region writes must
shard into independent buses (e.g. by `type` or `subject`), each with its own
order; cross-shard coordination is then a client concern, not the bus's.

A bus MAY serve a **materialized view** (`GET /facts/<id>/state`,
`/trust`, …) as a cache of §3 folds. Such views are conveniences and MUST be
identical to a from-scratch fold with the same log position, rules, parameters,
and calculation time; they are never a second source of truth.

---

## 8. Defaults

| Parameter | Default | Note |
|---|---|---|
| Causation depth cap | 64 | §5 — generous; cycles are the real risk, not depth |
| Reader quorum (trust) | 2 | §3.2 — reader policy, not server config |
| Claim-timeout (on `recv`) | 600 s | §3.1 — a claim whose bus-stamped `recv` is older than this folds as released |
| Per-author rate (if enabled) | 20 burst / 5 per s | §5 |
| Log fsync | server: `everysec`; embedded: `always` | Server configuration uses `everysec`; direct `new BusV2()` / `new JsonlLog()` defaults to `always` |

Note these are mostly **reader** or **operator** knobs. The trusted core has
almost nothing to configure — another consequence of §0.2.

---

## 9. v1 → v2 mapping (for migrators)

| v1 | v2 |
|---|---|
| `POST /facts {mode, priority, ttl, …}` | `POST /facts {type, author, ts, payload, refs}` |
| `POST /facts/:id/claim` | `POST /facts { type:"_.claim", refs:{claim_of:id} }` |
| `POST /facts/:id/resolve {result_facts}` | `POST /facts { type:"_.resolve", refs:{resolves:id} }` + child facts with `refs.parent:id` |
| `POST /facts/:id/corroborate` | `POST /facts { type:"_.vote", payload:{verdict:"corroborate"}, refs:{vote:id} }` |
| `GET /facts?state=published` | `GET /facts?since=N` then fold §3.1 client-side (or hit a materialized view) |
| fact.`state` / `epistemic_state` | `fold(stream)` §3 |
| ant connect / heartbeat / TEC | removed; `author` is a free-form string, reliability is a reader fold over outcomes if wanted |

A v1→v2 shim can run as a reader: it folds the v2 stream and re-exposes the v1
REST surface for legacy clients, with zero changes to the trusted core.

---

## 10. Lineage

| Source | What v2 takes |
|---|---|
| **Blackboard architecture / stigmergy** | a shared medium everyone writes observations to and nobody is addressed through; ants read the ground, not each other. v2 keeps the board and drops the control component: the total order arbitrates |
| **Event sourcing / CQRS** | the log is the only truth; state is a projection |
| **Git** | content-addressed, immutable, append-only; `fetch` by cursor |
| **Lamport / total order** | a unique winning active claim under the same fold inputs |
| **CAN bus** | content-addressed broadcast + local (reader) filtering |
| **Scientific method** | contestable facts (corroborate/contradict), no central arbiter |

---

*Protocol v2.0 by Carter.Yang. The bus orders and preserves; readers decide
meaning. The Node implementation is the current encoding baseline; regression
vectors protect existing encodings without claiming complete interoperability.*
