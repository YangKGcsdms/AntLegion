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
node — folds the same log into the same world. Nothing in it is a command,
because a command has a recipient and the log has none. The lineage is
stigmergy: ants do not address each other; they read the ground. The ground
here is a totally-ordered, append-only, content-addressed log, and "reading
the ground" is a deterministic fold (§3).

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
statement about the world, never an instruction to anyone. There are no
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
| atomic `claim` endpoint + arbitration | append a `claim` fact; **lowest `seq` referencing the target wins** — ownership is world state, and exactly-once is a theorem of total order |
| TTL → `dead` transition | reader-side filter / compaction hint; never a server state change |
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
  "payload": { "...": "..." },      // arbitrary JSON. MUST (MAY be {}).
  "refs":    { "...": "..." },      // links to other facts — the ONLY relational mechanism. MAY be absent.
  "nonce":   "k7…",                 // optional uniqueness token: a legitimate repeat (e.g. re-claim) gets a distinct id (§4). MAY be absent.
  "sig":     "hmac…"                // bus signature over (id, author, type, ts, recv, seq). Set by bus.
}
```

`refs` is where every relationship lives. Every value is a **fact id, never an
agent id** — that is the structural reason there are no commands: a fact can
say what it is about, it cannot say who it is for. Defined keys:

| `refs` key | Value | Meaning (a reader fold interprets it) |
|---|---|---|
| `parent` | fact id | This fact was caused by that one. Causation = transitive `parent` (§3.4). |
| `subject` | string | Names the piece of the world this fact is about; the group key for the latest-wins **register** (§3.3). |
| `supersedes` | fact id | The target is **replaced by a successor** (this fact). |
| `tombstones` | fact id | A `_.tombstone` marks the target **retracted / GC'd** — distinct from `supersedes`, which means *replaced*. Folds MUST tell the two apart (§5.2). |
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
  { type, author, ts, payload, refs?, id? }
→ 201 { seq, id, sig }            // id/sig echoed; id MAY be sent as "" for the bus to compute
→ 409 { error: "id mismatch" }    // integrity failure
```

Append is the only write. The bus assigns `seq`, verifies/derives `id`, signs,
persists, returns. No mode, no token-gated claim, no priority. (Auth, if any, is
a transport concern — see §6.)

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
the bus. Two readers that fold identically will always agree, because they
consume the same totally-ordered, immutable stream — and that is the whole
point: two agents on two machines with no channel between them but the log
compute the same world.

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

**Ownership is world state, and exclusivity is a theorem, not a lock.** If
several authors append `claim_of: F`, the one with the **lowest `seq` wins** —
every reader computes the same winner from the same totally-ordered,
`recv`-stamped stream, exactly as every reader computes the same current value
of a register (§3.3). No atomic
endpoint, no leader election, no hot-path arbitration. A claimer confirms it won
by reading `F`'s claim set back and seeing no live `claim_of: F` at a lower
`seq`; to keep that O(claims-on-F) instead of O(log), a bus SHOULD support the
`?refs.claim_of=<id>` filter (§2.2). Timeout-based release is deterministic
**only because it keys on the bus-stamped `recv`**, not the author's `ts`; a
`release_of` by the claim's author ends the claim immediately regardless of Δ.

**A `resolve` is authorization-gated by the fold**: a `resolves: F` is honored
only from `F`'s current claim winner. This stops a non-claimer from marking
someone else's claimed work done. (For never-claimed broadcast facts, any author
may resolve and the lowest-seq resolve wins.)

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
(`seq`-deterministic, §3.1), which every reader computes identically. Trust is
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

supersededBy(F) = the fact that replaced F: an explicit `supersedes: F` if any,
                  else the next-higher-seq fact in F's subject group, else null
```

Every reader that folds `current(S)` from the same stream gets the same fact —
on any machine, at any later time, after any replay. That is what makes a
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
reconstructs the same trail. Because facts are immutable and removed only by
explicit `tombstone` (§5.2), a chain never silently loses an ancestor — a
reader encountering a tombstoned ancestor sees the tombstone, not a gap. And
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

`id` is the content address: `id = sha256(canonical(record))`, where the
canonical record is the JSON object of `{type, author, ts, payload, refs, nonce}`
(`nonce` included only when present) with recursively sorted keys and floats
rendered with a trailing `.0` (Python-`json.dumps`-compatible). `seq`, `recv`,
`sig`, and `id` itself are excluded — they are bus-assigned, not content.

Content addressing gives dedup for free, but with a sharp edge that the protocol
resolves **one** way, explicitly: **append is idempotent by `id`.** The bus keeps
an `id → seq` index (rebuilt from the log on recovery — a pure projection, not
authoritative state); appending an `id` that already exists returns the existing
`{seq, recv, sig}` and does **not** write a second copy. "Resubmit is safe" is
therefore the default. The consequence: a *legitimate repeat* — re-claiming `F`
after releasing it — would otherwise collapse into the original, so a client
wanting a genuinely **new** action MUST make the content distinct, normally by
setting a fresh `nonce` (§1). Relational facts (`_.claim`, `_.resolve`,
`_.vote`) SHOULD always carry a `nonce`. This is exactly the model of a
content-addressed store like git: identical content is one object; you change
the content to get a new one.

The bus signs every accepted fact: `sig = hmac_sha256(secret, "id|author|type|ts|recv|seq")`.
A verifier recomputes that HMAC and compares (constant-time) to `sig`; because
the key is symmetric, **only a holder of the secret can verify** — the bus on
recovery (a failing `sig` means the log was tampered or written under a
different secret), or a read-replica that shares the secret. An unauthenticated
HTTP reader cannot verify `sig`; for it, the content address `id` is the
integrity check, and `seq`/`recv` are trusted by trusting the bus.
Operators MUST set a stable `ANTLEGION_BUS_SECRET` so signatures verify across
restarts. A **canonical cross-language conformance vector set** ships with the
protocol; any implementation (TS, Python, Go, …) MUST reproduce its hashes
byte-for-byte. This vector set — not prose — is the interop contract.

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

### 5.2 Deletion is a fact

The bus never mutates or silently drops a stored fact. Removal is itself an
appended `tombstone` fact (`type: "_.tombstone"`, `refs.tombstones` → target).
Deletion gets its **own** ref key, never `supersedes`: superseding means *a
successor replaced this*; tombstoning means *this is gone*. The folds (lifecycle
§3.1, trust §3.2, register §3.3) MUST distinguish them — a retracted fact is
`dead` (its register folds to null, §3.3), never `superseded`. Compaction (§7) MAY then physically drop a fact's
*payload*, but MUST retain its full skeleton — `{id, seq, recv, author, refs,
sig}` — because every fold depends on it: causation walks need `refs.parent`;
the claim winner needs `seq` + `author` + `refs.claim_of`; trust needs `author`
+ `refs.vote`. Dropping `refs` or `author` would destroy the very relationships
the folds are computed from. Retaining the skeleton is how v2 keeps both
causation and coordination durable across compaction.

---

## 6. Auth (transport-layer, optional)

v1 baked tokens into claim/resolve. v2 removes per-operation auth from the
semantics: since exclusivity is decided by `seq` order and *who* claimed is just
`author`, authentication is purely about "is this author who they say." That is
a **transport concern** (mTLS, a gateway, an API key header), out of scope for
the fact model. A deployment MAY run the bus open (trusted network) or behind
an authenticating proxy that stamps/validates `author`. The protocol does not
mandate a scheme, but a public deployment SHOULD authenticate `author` and
SHOULD NOT expose write access unauthenticated.

---

## 7. Storage & recovery

The bus is an append-only log (one JSON record per line, fsync per append or
per batch). Recovery: read the log in order; on a torn final record, truncate to
the last byte offset that parses, then resume appending. There is **no
in-memory state machine to rebuild** — the log *is* the state, and `seq` is
restored from the last record. This is the reliability dividend of §0.2.

Compaction folds the log to a checkpoint: snapshot the current projection
(optional, derived, never authoritative) and drop superseded/tombstoned
*payloads* while retaining the full `{id, seq, recv, author, refs, sig}`
skeleton (§5.2). Compaction MUST use temp-file + atomic rename.

**Total order ⇒ a single logical appender.** `seq` is one global sequence, so
all writes funnel through a single logical append point. High availability is
therefore *single-writer with failover* (e.g. Raft replicating the append
position), **not** multi-master — there is no way to merge two independent
orders without losing the exactly-once guarantee (§3.1). Reads scale out freely
across log replicas. A deployment that genuinely needs multi-region writes must
shard into independent buses (e.g. by `type` or `subject`), each with its own
order; cross-shard coordination is then a client concern, not the bus's.

A bus MAY serve a **materialized view** (`GET /facts/<id>/state`,
`/trust`, …) as a cache of §3 folds. Such views are conveniences and MUST be
bit-identical to a from-scratch fold; they are never a second source of truth.

---

## 8. Defaults

| Parameter | Default | Note |
|---|---|---|
| Causation depth cap | 64 | §5 — generous; cycles are the real risk, not depth |
| Reader quorum (trust) | 2 | §3.2 — reader policy, not server config |
| Claim-timeout (on `recv`) | 600 s | §3.1 — a claim whose bus-stamped `recv` is older than this folds as released |
| Per-author rate (if enabled) | 20 burst / 5 per s | §5 |
| Log fsync | per append | trade for per-batch under load |

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
| **Lamport / total order** | exactly-once exclusivity as a *theorem* of order |
| **CAN bus** | content-addressed broadcast + local (reader) filtering |
| **Scientific method** | contestable facts (corroborate/contradict), no central arbiter |

---

*Protocol v2.0 by Carter.Yang. The bus orders and preserves; readers decide
meaning. Keep the trusted core small enough that a second implementation is a
weekend, and let the conformance vectors — not prose — guarantee interop.*
