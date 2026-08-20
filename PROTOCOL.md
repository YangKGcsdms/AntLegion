<div align="center">

🌐 **English** · [简体中文](PROTOCOL.zh-CN.md)

</div>

# AntLegion Protocol — v3.0

> **A shared world-state log for agents that share nothing else.**
>
> Facts, not commands. One order. One read. The world is a fold.
>
> Designed by **Carter.Yang**. Re-derived from the shared-world-state primitive, 2026.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHOULD**,
**SHOULD NOT**, **MAY**, and **OPTIONAL** are per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

Each requirement names its subject explicitly — **a bus MUST…**, **a reader
MUST…**, **an author MUST…** — because this protocol has three distinct
conformance targets (§9).

---

## Status

**Version 3.0. Stability: draft.**

`MAJOR` increments when the canonical record (§4), the fact shape (§1), or the
output of any §3 fold over an existing stream changes. `MINOR` increments on a
strictly additive change — a new fold, `refs` key, fact type, or endpoint — such
that a `MINOR-n` reader still folds a `MINOR-n+1` stream correctly. A bus MUST
report `protocol: "<MAJOR>.<MINOR>"` (§2.5). Every normative change lands in the
changelog below **together with** a regenerated vector set and its cross-language
verifier, in one commit declared as a protocol change; a normative fold added
without a vector is not part of the contract (§9.1). Sections added after 3.0
carry a `since` marker.

This version is **not wire-compatible with v2.0**: content addresses change
(§4 adopts RFC 8785), and several reader folds change their output on inputs
v2.0 left undefined or left open to any writer (§3.1, §3.3, §3.4). Any v2.0
conformance vector set MUST be regenerated.

v3.0 is a re-derivation, not an edit. v2.0 was structured as a migration
argument away from v1 — its derivation chapter was titled "why v2 looks like
this", it ordered the reader folds by rule length rather than by need, and it
carried a v1→v2 mapping appendix for a version that was never published. This
version starts from the primitive the system actually serves — **shared world
state** — and derives everything from it. What v2.0 got right is preserved
verbatim in substance; what it inherited has been removed.

### Changelog (v2.0 → v3.0)

| Change | Section | Kind |
|---|---|---|
| Derivation rebuilt on the shared-world-state primitive; v1 migration material deleted | §0, §9 (v2) | editorial |
| Fold order now follows the questions an isolated agent asks; ownership moved last and re-framed as a corollary | §3 | editorial |
| "No commands" re-argued as *no delivery semantics* rather than *addressing is unrepresentable* | §0.2 | normative clarification |
| Canonicalization replaced by **RFC 8785 (JCS)**; the `ts`-only trailing-`.0` rule deleted | §4 | **breaking** |
| `refs` values: empty string and `null` now rejected at append instead of silently dropped at hash time | §1, §6 | **breaking** |
| `current(S)` simplified: successors MUST carry the subject; the forward-walk is gone; reserved-namespace facts are not register members | §3.1 | **breaking** |
| `supersededBy(F)` defined as the **immediate** successor, with a stated tie-break; retracted and unauthorized successors excluded | §3.1 | **breaking** |
| A fact MUST NOT carry more than one lifecycle ref; the bus rejects it | §1, §3.4, §6 | **breaking** |
| `resolves` gate tightened to **the current claim winner only** — the ungated never-claimed path is removed | §3.4 | **breaking** |
| Δ (claim timeout) is a property of the log, published by the bus; readers MUST NOT override it | §3.4, §8 | **breaking** |
| `trust` gains a `retracted` state; `quorum` MUST be ≥ 1 | §3.3 | **breaking** |
| Folds are defined over a **complete prefix**; filtered/partial windows are non-normative | §3 | normative clarification |
| Dangling ancestors surface as an explicit gap instead of silent truncation | §3.2 | **breaking** |
| `supersedes` is now gated on the target's author, closing a trust-hijack | §1.2, §3.1, §5.1 | **breaking** |
| New: authorization model — which refs keys are self-asserted vs fold-gated | §5 | new |
| New: value domains and hard limits for every field | §1 | new |
| New: conformance levels and what a vector set must pin | §9 | new |
| Recovery MUST truncate a torn tail; a `seq` MUST NOT be reused | §7 | **breaking** |
| Compaction MUST NOT change any fold result; supersession alone no longer makes a payload droppable | §7 | **breaking** |

---

## 0. The derivation

Everything below is a consequence of one situation. Read this chapter and you
should be able to reconstruct the rest of the document yourself.

### 0.1 The situation

Two agents share **nothing**. Not a process. Not a memory space. Not a machine,
a vendor, a runtime, or a clock. They may be a Python worker in a CI runner and
a hosted assistant behind someone else's API. They come and go independently and
neither can call the other.

They nevertheless need to **agree on the world**: what happened, what the value
of X is now, how it got that way, what it led to, and whether any of it can be
trusted.

Today the medium between such agents is a human copying state out of one window
and into another. This protocol is that medium.

Note carefully what is **not** in the situation. Nobody needs to be told what to
do. Nobody is dividing work, scheduling, delegating, or waiting on anybody.
Those problems require a shared authority to be the divider, the scheduler, the
delegator — and a shared authority is precisely what these agents do not have.
An agent decides its own actions, alone, from what it believes about the world.
The only thing that has to be shared is the world.

> **Scope.** Steps, assignments, dispatch, retries, and DAGs are workflow
> concerns and are out of scope. They are built *on top of* a shared world by
> clients, and this protocol has nothing to say about them.

### 0.2 Why the medium carries facts and not commands

Suppose the medium carried commands. A command names a recipient. Naming a
recipient requires an addressing scheme; an addressing scheme requires everyone
to agree on who exists and what they are called; that agreement is shared
mutable state that must itself be maintained — and maintaining shared mutable
state is the problem we started with. The construction is circular.

There is a second, independent reason. A command is meaningful to exactly one
party: its recipient. A fact is meaningful to every party. Among *n* isolated
agents a command has an audience of one and a fact has an audience of *n*. If
the medium is expensive to establish — and between agents that share nothing it
is the *only* thing that is established — it should carry the thing whose value
scales with the number of participants.

Therefore:

> **A fact is a statement about the world. It is never an instruction to a
> party.**

**What this axiom does and does not claim.** It does not claim that addressing
is unrepresentable. It cannot: any string field can encode a name, and an author
who writes `subject: "for:bob"` and a reader named Bob who polls for it have
built an inbox out of two strings. No log can prevent that, and a specification
that claims otherwise is simply wrong.

What the protocol guarantees is narrower and actually true:

> **There are no delivery semantics anywhere in this protocol.** No field the
> bus interprets as a recipient. No per-agent queue, mailbox, subscription, or
> routing table. No push, no delivery, no acknowledgement, no obligation to
> read. Every reader folds the same whole world at its own pace, and no fact is
> ever *for* anyone.

An "addressed" fact is therefore **inert**. It becomes a command only if the
agent that recognizes its own name independently chooses to treat it as one —
which is a property of that agent's code, not of this log. The protocol's job is
to make sure it never *helps*: it MUST NOT privilege addressing, and it never
does, because there is nothing in the trusted core or the fold layer that knows
what an agent is.

The structural consequence is recorded in §1: **every `refs` value names a fact
or a piece of the world; none names a party.**

### 0.3 What a fact must therefore be

Three properties follow directly from "agents that share nothing must agree":

1. **Immutable.** Agreement on a moving target is not agreement. If a statement
   can change after being read, two agents that read it at different times have
   not agreed on anything. So a fact is frozen when written; change is expressed
   by writing another fact (§3.1), and removal by writing a third (§5.3).

2. **Attributable.** "The world according to nobody" cannot be assessed. Every
   fact carries an `author`, so a reader can weigh, corroborate, or discount it
   (§3.3). Note that attribution is a *claim* by the writer, not an identity
   proof — see §5.4.

3. **Named without a naming authority.** Two parties with no shared registry
   still have to refer to the same fact by the same name. A server-assigned
   identifier would make the server the naming authority and would not survive
   replication or export. The only naming scheme that needs no authority is one
   where the name is computed from the content:

   > `id = hash(content)` — the **content address** (§4).

   Content addressing pays for itself three more times: identical content is
   automatically one fact (dedup), a fact cannot be altered without changing its
   name (integrity), and a reference to a fact is a reference to *that exact
   content* forever (§3.2).

### 0.4 Why a single total order

Two agents must fold the same statements into the **same** world. Concurrent
statements about the same thing do not converge on their own; you must either
restrict what can be said until it commutes (the CRDT bargain, which would
constrain the world model to whatever the lattice can express) or impose an
order and let everyone read it the same way.

This protocol imposes the order. A single, strictly increasing `seq` is assigned
by one logical appender, and:

> **The total order is the bus's only authority.**

Every question that could otherwise require arbitration reduces to "which came
first", and every reader answers it identically because every reader reads the
same sequence. This is what makes the folds in §3 deterministic, and it is why
§3.4's exclusivity result is a theorem rather than a lock.

### 0.5 Why append-only

How the world came to be in its current state is *itself* world state — it is
one of the four questions in §0.7. Mutation destroys exactly that. An
append-only log is also the only structure two parties can converge on while
agreeing on nothing but the order: to catch up you ask for everything after a
position, and there is no reconciliation step.

So the log grows, and removal is not an operation on the log but a fact written
into it (§5.3). Compaction may later reclaim space, but it MUST NOT change what
any fold returns (§7).

### 0.6 What the bus must therefore be

From §0.3–§0.5, the trusted core is small and fixed. A bus MUST provide exactly
these four things:

1. **Order** — assign a strictly increasing `seq` (§0.4).
2. **Integrity** — verify `id == hash(record)` and reject mismatches (§4).
3. **Durability** — persist to a log that survives restart without losing an
   acknowledged fact (§7).
4. **Range read** — return facts with `seq > since`, in order (§2.2).

And a bus MUST NOT have per-fact mutable state, a state machine, a claim table,
a trust computation, dispatch, arbitration, or push. It is a verifiable,
totally-ordered, append-only log — the smallest object on which §3 can be
derived. (Compare: a single signed Kafka partition, or git with a sequence.)

> **Axiom of non-adjudication.** The bus orders and preserves facts. It never
> decides what they *mean*. Meaning is computed by readers (§3). This is why
> ownership, trust, and currency are folds and not server state — and it is what
> keeps the trusted core small enough that a second implementation is a weekend.

### 0.7 The four questions

Everything a physically isolated agent needs from a shared world is one of four
questions, and each is a fold over the same stream. **They are presented in the
order an agent actually needs them:**

| # | question | fold | §
|---|---|---|---|
| 1 | **what is X right now** | the subject register | §3.1 |
| 2 | **how did this come to be · what did it lead to** | the causal trail | §3.2 |
| 3 | **should I believe it** | trust | §3.3 |
| 4 | **who is responsible for it** | ownership | §3.4 |

Question 4 is **a corollary, not a purpose**. Responsibility for a fact is just
another piece of world state, and because the world is totally ordered, the
answer happens to be unambiguous — which yields exactly-once claiming for free
(§3.4). That result is genuinely useful and it is fully normative here, but it
is the *last* thing the log is for, not the first. A stream with no `_.claim` in
it is a perfectly good world; see `examples/scenario-shared-view.ts`.

---

## 1. The Fact

```jsonc
{
  "seq":     1337,                  // bus-assigned position in the total order
  "recv":    1748300000.4,          // bus-assigned TRUSTED receive time (unix s)
  "id":      "b3f1…",               // content address = hash of the canonical record (§4)
  "type":    "build.failed",        // dotted taxonomy
  "author":  "claude-code",         // who wrote it (self-asserted, §5.4)
  "ts":      1748300000.0,          // unix seconds, author-stated — ADVISORY
  "payload": { "...": "..." },      // arbitrary JSON object
  "refs":    { "...": "..." },      // links — the ONLY relational mechanism
  "nonce":   "k7…",                 // uniqueness token (§4)
  "sig":     "hmac…"                // bus signature (§4)
}
```

### 1.1 Fields

| field | presence | type & domain |
|---|---|---|
| `type` | REQUIRED (author) | Non-empty string, ≤ 256 bytes UTF-8. Dotted segments matching `[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*`. |
| `author` | REQUIRED (author) | Non-empty string, ≤ 256 bytes UTF-8. Opaque; no structure imposed. |
| `ts` | REQUIRED (author) | **Finite** IEEE-754 double, unix **seconds**. `NaN` and ±`Infinity` MUST be rejected. Advisory only (§1.3). |
| `payload` | REQUIRED (author) | A JSON **object** (`{}` is valid). A non-object payload MUST be rejected. ≤ 1 MiB serialized, by default (§8). |
| `refs` | OPTIONAL | A JSON object; every value MUST be a non-empty string. `null` and `""` MUST be rejected, not dropped. Absent is equivalent to `{}`. ≤ 64 keys by default (§8). |
| `nonce` | OPTIONAL | Non-empty string, ≤ 128 bytes. `""` MUST be rejected. |
| `id` | OPTIONAL on append, REQUIRED on a stored fact | Lowercase hex sha256 of the canonical record (§4). If an author supplies it, the bus MUST verify and reject a mismatch. |
| `seq` | bus-assigned | Integer ≥ 1. **The first fact in a log has `seq` 1**, so a fresh reader starting at `since = 0` sees everything. |
| `recv` | bus-assigned | Finite double, unix seconds, bus-witnessed. MUST be non-decreasing in `seq` (§7). |
| `sig` | bus-assigned | §4. |

A bus MUST reject a fact violating any of the above with `400` (§2.1) and MUST
NOT store it. A bus MUST ignore and MUST NOT store unknown top-level fields;
authors MUST NOT rely on them surviving, and MUST place extensions in `payload`.

Values that a reader can derive — lifecycle state, claim holder, vote tallies,
supersession status — MUST NOT be written into a fact as though authoritative.
This is an authoring rule and is not machine-checkable; a reader MUST compute
these from §3 and MUST NOT trust a payload field that purports to state one.

### 1.2 `refs` — the only relational mechanism

Every `refs` value names **a fact or a piece of the world. None names a party**
(§0.2). Defined keys:

| key | value | meaning | who may write it | fold gate |
|---|---|---|---|---|
| `parent` | fact id | This fact was caused by that one; causation is transitive `parent` (§3.2). | anyone | none — see §5.2 |
| `subject` | world name | Names the piece of the world this fact is about; the group key of the register (§3.1). | anyone | none |
| `supersedes` | fact id | This fact **replaces** the target. | the target's author only | §5.1 |
| `tombstones` | fact id | On a `_.tombstone`: the target is **retracted**. Distinct from `supersedes` (§5.3). | target's author only | §5.1 |
| `vote` | fact id | With `payload.verdict ∈ {corroborate, contradict}` (§3.3). | anyone but the target's author | §5.1 |
| `claim_of` | fact id | Author asserts responsibility for the target (§3.4). | anyone | ordering (§3.4) |
| `resolves` | fact id | The target is handled; `payload` MAY carry the result. | the current claim winner only | §5.1 |
| `release_of` | fact id | Author abandons its own prior claim. | the claiming author only | §5.1 |
| `about` | fact id | `context.requested`: the fact found too thin to act on (§3.5). | anyone | none |
| `answers` | fact id | `context.provided`: the request it answers (§3.5). | anyone | none |

A bus MUST accept unknown `refs` keys (forward compatibility) and MUST NOT
interpret them. The trusted core reads `refs.parent` only, and only to enforce
§6.2. Readers MUST ignore keys they do not understand.

`claim_of`, `resolves`, `release_of` and `tombstones` are the **lifecycle refs**.
A fact MUST NOT carry more than one of them, and a bus MUST reject one that
does (§6.1). This removes the only case in which the §3.4 fold order would be
ambiguous.

A `subject` is a **world name**, not a fact id: an opaque non-empty string, ≤ 256
bytes, chosen by writers who agree on it out of band (`deploy:prod`,
`schema:orders`, `belief:customer-42:churn-risk`). Two agents that have never met
write to the same piece of the world by agreeing on a name — which is exactly why
it cannot be a content address. Authors SHOULD name a piece of the world and
SHOULD NOT name a recipient (§0.2).

### 1.3 `ts` versus `recv`

`ts` is what the author *claims* the time was. It is part of the content hash and
is **advisory**: a skewed or hostile clock can set it anywhere.

`recv` is what the bus *witnessed*. It is signed and **trusted**.

> **Every time-dependent fold MUST key on `recv`, never on `ts`.**

Otherwise two readers reach different conclusions from the same stream and the
fold stops being deterministic — which would defeat §0.4. `seq` and `recv` are
the bus's two trusted stamps: `seq` for order, `recv` for time.

### 1.4 Reserved type namespaces

The following `type` prefixes are **reserved** by this protocol. Authors MUST NOT
mint types under them except as defined here, and readers MUST NOT assign them
application meaning.

| prefix | owner | defined members |
|---|---|---|
| `_.` | this protocol | `_.claim`, `_.resolve`, `_.release`, `_.vote`, `_.tombstone` |
| `sys.` | operational conventions | `sys.registry` (§3.5) |
| `context.` | the clarification convention | `context.requested`, `context.provided` (§3.5) |

A fold that keys on a reserved type MUST key on the `type` field, not merely on
the presence of a `refs` key. Specifically: a `_.tombstone` is recognized by
`type == "_.tombstone"` **and** a `refs.tombstones` value; a `_.vote` by
`type == "_.vote"` **and** `refs.vote`. Claims, resolves and releases are
recognized by their lifecycle ref, and their `type` SHOULD be the reserved one
but MUST NOT be required to be.

---

## 2. Bus operations

This chapter is the **complete protocol wire surface**: one write, one read, two
read conveniences. An implementation MAY serve additional endpoints (§2.5), but
none of them may be required to fold the world, and none may change what a fold
returns.

### 2.1 Append

```
POST /facts
  { type, author, ts, payload, refs?, nonce?, id? }

→ 201 { seq, recv, id, sig, deduped: false }   // stored
→ 200 { seq, recv, id, sig, deduped: true }    // identical id already present (§4.3)
→ 400 { error, code }                          // malformed: field domain violated (§1.1)
→ 409 { error, code: "id_mismatch" }           // supplied id != computed id
→ 409 { error, code: "depth_exceeded" }        // §6.2
→ 413 { error, code: "too_large" }             // §8 limits
→ 507 { error, code: "storage" }               // could not durably persist
```

Append is the only write in the protocol. The bus assigns `seq` and `recv`,
verifies or derives `id`, signs, persists **durably**, and returns. There is no
mode, no priority, no token-gated claim.

A bus MUST NOT return 2xx before the fact is durable under its configured
durability policy (§8), and MUST NOT assign a `seq` it has ever assigned before
(§7.1). Every error response MUST carry a machine-readable `code` from the set
above; a client MUST be able to distinguish an integrity failure from a policy
rejection from a storage failure without parsing prose.

### 2.2 Read

```
GET /facts?since=<seq>&limit=<n>&type=<glob>&author=<id>&refs.<key>=<value>

→ 200 [ fact… ]                    // ascending by seq
   X-Max-Seq:  <cursor to pass as the next `since`>
   X-Has-More: true | false
```

`since` is the cursor; pass back `X-Max-Seq` to get only what is new. This is the
canonical access pattern — closer to `git fetch` than to a queue.

- `X-Max-Seq` MUST be `max(since, highest seq returned)`. It is therefore always
  a valid next cursor, including when the result is empty.
- `X-Has-More` MUST be `true` when facts matching the query exist beyond
  `X-Max-Seq` at the time of the read. A reader MUST NOT treat a short or empty
  page as the end of the stream; it MUST use `X-Has-More`. (In v2.0 a truncated
  window was indistinguishable from an exhausted one, which silently lost facts.)
- `limit` defaults to 100 and MUST be clamped to an implementation maximum
  (default 10 000, §8). A bus MUST NOT return more than `limit`.
- A bus MUST **reject** a malformed `since` or `limit` with `400`, and MUST NOT
  coerce it to a default. Coercing a non-numeric `since` to zero turns one junk
  query into a full-log read.

**Filters are a transport optimization and nothing more.** They change which
facts are returned, never their meaning or order. A bus MAY ignore `type`,
`author` and `refs.*` and remain conforming.

> **A reader MUST NOT compute a §3 fold over a filtered or truncated window.**

§3's folds are defined over a complete prefix (§3, preamble). A claim, a vote or
a tombstone that the filter excluded changes the answer, so folding a filtered
window yields an approximation with no guarantees. Filters exist to let a client
*find* facts cheaply and to let a claimant confirm a win in O(claims on F)
(§3.4); they do not exist to fold on.

`type` accepts a glob in the dialect defined in §2.4. A bus MUST honour at most
one `refs.<key>` filter; if a client sends several, the bus MUST reject the
request with `400` rather than silently picking one.

### 2.3 Read conveniences

```
GET /facts/head → { head_seq }     // start a fresh reader at "newest only"
GET /facts/<id> → fact | 404       // fetch one by content address
```

### 2.4 The `type` glob dialect

Exactly two metacharacters, matched against the whole `type` string:

- `*` matches zero or more characters.
- `?` matches exactly one character.

`*` spans `.` like any other character. No character classes, no escaping, no
alternation, no `**`. Every other character matches itself literally.

A conforming implementation MUST match in time bounded by
`O(len(pattern) × len(text))` — a two-pointer matcher — and MUST NOT compile the
pattern to a backtracking regular expression. This is normative because both
sides are attacker-supplied: the pattern arrives in `GET /facts?type=` and in
`sys.registry.interests` (§3.5), and the text is any fact's `type`. A
backtracking translation is exponential, so two well-formed facts are enough to
stall every reader that folds §3.5 and to block the bus's own event loop.

### 2.5 Endpoints outside the protocol

An implementation MAY serve operational endpoints — health, introspection, a
dashboard, compaction triggers. They are **not part of this protocol**, MUST NOT
be required by any reader, and are bound by one rule:

> **An operational endpoint MUST NOT change the result of any §3 fold.**

This rule is normative and it forbids a real hazard: a compaction endpoint that
strips payloads can silently change a vote tally, because §3.3 reads
`payload.verdict`. See §7.2.

Two conventional endpoints, if present, SHOULD take these shapes:

```
GET /health → { status, protocol, head_seq }
GET /info   → { protocol, head_seq, claim_timeout, max_depth, limits… }   // §8
```

`/info` is how a reader learns Δ (§3.4, §8), so a bus that implements claiming
SHOULD serve it.

---

## 3. Reader folds — the world

A reader replays facts in `seq` order and folds them into whatever projection it
needs. **These fold rules are normative**: conformance lives here, not in the
bus. Two readers that fold identically always agree, because they consume the
same totally-ordered, immutable stream — and that is the entire point.

> **Domain of a fold.** Every fold in this chapter is a function of a
> **complete prefix** of the log: all facts with `1 ≤ seq ≤ N`, for some `N`.
> A reader MUST hold a complete prefix to claim a normative result. Folding a
> filtered, sampled, or gap-containing window is permitted but yields a
> non-normative approximation, and an implementation SHOULD NOT present such a
> result as a fold defined here.
>
> Two readers at different `N` may of course differ — one has seen more of the
> world. That is not disagreement; it is latency. Disagreement means two readers
> at the **same** `N` returning different answers, and §3 exists to make that
> impossible.

> **Termination.** A fold that walks `refs` links MUST terminate on any input,
> including a stream that a well-behaved bus would never produce. Implementations
> MUST bound each walk with a visited-set or an explicit depth cap. Do not rely
> on §6.2's argument that cycles are unconstructible: it holds for facts appended
> through a conforming bus, and folds also run over exported, replicated and
> hand-repaired logs.

The four questions of §0.7, in order.

### 3.1 What is X right now — the subject register

A `refs.subject` names a piece of the world. Every fact carrying that subject is
a statement about it; together they are the subject's **register**. This is how a
value that keeps changing is shared between isolated agents without anyone
holding it: nobody stores "the current value", every reader folds it.

```
retracted(x) = ∃ t ∈ prefix : t.type == "_.tombstone"
                              and t.refs.tombstones == x.id
                              and t.author == x.author            # §5.1

history(S) = [ f ∈ prefix : f.refs.subject == S
                            and f.type is not in a reserved namespace (§1.4) ],
             ascending seq

current(S):
  if history(S) is empty              → null
  h ← the highest-seq fact in history(S)
  return retracted(h) ? null : h                                  # §5.3: nothing is known

supersededBy(F):                        # the fact that IMMEDIATELY replaced F
  E ← [ x ∈ prefix : x.refs.supersedes == F.id                    # explicit successors,
                     and x.author == F.author                     #   authorized (§5.1)
                     and not retracted(x) ]
  G ← [ x ∈ history(F.refs.subject) : x.seq > F.seq               # next in the register
                     and not retracted(x) ]
  C ← E ∪ G
  return C is empty ? null : the LOWEST-seq member of C

isSuperseded(F) = supersededBy(F) != null
```

Six rules make this deterministic where v2.0 was not:

1. **`current(S)` ranges over `history(S)` only.** A fact that wants to become
   the current value of S MUST carry `refs.subject: S`. In v2.0 an explicit
   successor could become `current(S)` without carrying the subject, so
   `current(S) ∉ history(S)` was reachable and the two folds disagreed about
   which facts were live. To say what X is now, say it *about X*.

2. **`supersededBy` returns the immediate successor**, the lowest-seq candidate —
   not the newest one. "What replaced F" is the next statement, not the latest
   statement; the latest statement is `current(S)`. Following `supersededBy`
   repeatedly walks the register forward one step at a time.

3. **Ties are broken by `seq`,** which is total, so there is never a choice. If
   two authorized successors exist, the lower `seq` is the successor and the
   other is an ordinary fact that also claims to replace F. A reader that cares
   about such forks can enumerate `E` itself.

4. **Only an author may supersede their own fact** (§5.1). Replacement says
   *"my earlier statement is out of date"*; a third party observing staleness
   contradicts (§3.3) or writes to the register, and does not get to retire
   someone else's statement. This costs the register nothing — progression there
   happens by group order, not by explicit `supersedes` — and it closes a
   hijack: because `superseded` outranks every vote in §3.3, an ungated
   `supersedes` let any author silence any fact's trust state with one append.

5. **A retracted successor supersedes nothing.** If the fact that replaced F is
   itself later tombstoned, `supersededBy(F)` falls back to the next candidate
   and then to `null`. Otherwise retracting a bad replacement would leave the
   original permanently `superseded` — with nothing current in its place.

6. **Reserved-namespace facts are not register members.** Tagging a
   `_.tombstone` with `refs.subject` is a natural mistake, and without this rule
   the retraction itself becomes `current(S)` and simultaneously supersedes the
   fact it retracts — violating both "nothing is known" above and §5.3's
   requirement that a retracted fact is never `superseded`. A tombstone retracts
   through `refs.tombstones` alone.

**Retraction is not rollback.** A tombstoned register head folds to `null` —
*nothing is currently known* — and not to the previous value. Resurrecting an
older statement would assert something no author currently asserts. A tombstone
on a non-head member does not change `current(S)`; it marks that member
retracted for §3.3 and §7.2.

**Latest-wins is one reader policy, not the only one.** A reader accumulating
multi-source observations reads `history(S)` and does not collapse it. This is a
supported and expected use of a register; §7.2 protects it by forbidding
compaction from destroying non-head payloads.

Every reader folding `current(S)` from the same prefix gets the same fact — on
any machine, at any later time, after any replay. That is what makes a register
a *shared* register.

### 3.2 How did this come to be, and what did it lead to — the trail

```
chain(F)       = follow refs.parent transitively from F to a root, returned root→F
descendants(F) = every fact whose parent chain reaches F, transitively,
                 in seq order, F excluded
depth(F)       = |chain(F)|            # a fact with no parent has depth 1
```

Both are pure folds over the same prefix, so a reader on another node
reconstructs the same trail. For an `F` that is not in the prefix, `chain(F)` is
empty and `descendants(F)` returns the facts naming `F` as parent — the trail
below an unseen fact is still knowable, the trail above it is not. An
implementation MUST NOT report the absent `F` as a root.

**Gaps are explicit.** A `refs.parent` MAY name a fact that is not in the prefix —
because it has not arrived yet, or was filtered out, or never existed (§5.2). When
a walk reaches such a reference, an implementation MUST surface it as an explicit
**gap marker** carrying the unresolved id, and MUST NOT silently stop as though a
root had been reached. A truncated chain that looks complete is worse than no
chain: it turns "I could not see the origin" into "this is the origin".

**What the trail actually proves.** Because `id` is a content address, a `parent`
link names *that exact content* and cannot be re-pointed after the fact; because
facts are immutable and removal is explicit (§5.3), an ancestor cannot be
silently rewritten.

> The trail therefore proves that **the named ancestor existed and has not been
> altered**. It does **not** prove that the child was actually caused by it —
> anyone may write `parent` pointing at anything (§5.2). Provenance here is
> tamper-evident, not attested.

v2.0 claimed this was "provenance that holds across organizational boundaries
without anyone vouching for it". That is too strong: the *link* holds without
vouching; the *claim of descent* is the child author's assertion, and is worth
exactly what that author is worth (§3.3, §5.4).

### 3.3 Should I believe it — trust

Fold `_.vote` facts referencing `F`. A reader MUST ignore self-votes
(`vote.author == F.author`) and MUST count only each author's **latest** vote by
`seq`, so a voter who changes their mind is never double-counted.

```
trust(F, quorum):                        # quorum is the READER's policy; MUST be ≥ 1, default 2
  if F is tombstoned (§5.3)   → retracted     # the author took it back
  if isSuperseded(F) (§3.1)   → superseded    # freshness beats confidence
  V ← for each author a ≠ F.author, that author's highest-seq _.vote on F
      whose payload.verdict ∈ {corroborate, contradict}
      and which its own author has not retracted (§5.3)
  C ← |{ v ∈ V : verdict == corroborate }|
  X ← |{ v ∈ V : verdict == contradict }|
  if X ≥ quorum   → refuted
  if X > 0        → contested
  if C ≥ quorum   → consensus
  if C > 0        → corroborated
  else            → asserted
```

Three v2.0 defects are closed here. `retracted` is a distinct state: §5.3
requires trust to distinguish retraction from replacement, and v2.0 had no state
for it, so a tombstoned fact could fold to `consensus`. `quorum` MUST be ≥ 1,
because `quorum = 0` made every unvoted fact `refuted`. And a vote whose
`verdict` is missing or unrecognized is **excluded from `V` entirely** rather
than occupying its author's slot — in v2.0 a later junk vote silently cancelled
that author's earlier valid one.

To evaluate self-votes a reader needs `F` itself. If `F` is not in the prefix the
reader MUST NOT return a `trust` result; this is the domain rule of §3 restated,
and it is why a filtered window is not foldable.

**A quorum counts distinct `author` strings, so trust is worth exactly what
`author` is worth.** `author` is self-asserted and this protocol does not
authenticate it (§5.4). On a deployment that does not authenticate writers, one
writer manufactures any trust state at any quorum in either direction, and the
self-vote MUST above buys nothing — it is defeated by a second string. This is
the only fold whose result depends on authors being *distinct principals*
(§3.4's ordering results do not), and a reader on an unauthenticated bus MUST
treat every state above `asserted` as unverified.

**Trust has no global value, so never coordinate on it.** Because `quorum` is the
reader's choice, two readers can legitimately disagree about whether F is
`refuted` or `consensus`, and the bus does not adjudicate (§0.6). Any decision
all participants must agree on MUST be built on §3.4, which every reader computes
identically. Trust is for advice and triage, never for arbitration. Trust also
does not propagate: a reader that cares about a chain's validity walks §3.2 and
checks ancestors itself.

### 3.4 Who is responsible for it — ownership

This fold is a **corollary** of the three above: responsibility for a fact is one
more piece of world state, and because the world is totally ordered, the answer
is unambiguous. It is listed last because it is derived, not because it is
optional — it is fully normative, and it is where the log's most useful accident
lives.

**Δ (the claim timeout) is a property of the log, not of the reader.** A bus MUST
publish Δ (§2.5, `/info`) and every reader MUST fold with the published value. A
reader that substitutes its own Δ is **non-conforming**, and the guarantee below
does not hold for it. This is the single most important change in §3.4: in v2.0
Δ was a per-reader knob with a documented default, and two readers folding one
stream with different Δ disagreed not only about who held a claim but about
whether the work was `resolved` at all.

```
ownership(F):                            # facts referencing F, ascending seq
  active ← []                            # live claims: {author, seq, recv}
  for fact in [ x ∈ prefix : x has a lifecycle ref naming F ], ascending seq:

    if fact is a _.tombstone on F, authored by F.author  → return dead        # terminal §5.1

    active ← [ c ∈ active : fact.recv ≤ c.recv + Δ ]     # deterministic expiry, keyed on recv

    if   fact.refs.claim_of   == F.id:
         active.push(fact)
    elif fact.refs.release_of == F.id and fact.author ∈ active.authors:
         drop fact.author from active
    elif fact.refs.resolves   == F.id:
         owner ← lowest-seq author in active, or null
         if owner != null and fact.author == owner  → return resolved(owner)   # terminal
         # otherwise NOT honoured: only the current claim winner may resolve.

  active ← [ c ∈ active : now ≤ c.recv + Δ ]              # trailing expiry only
  return active ? claimed(lowest-seq author in active) : open
```

A fact carries at most one lifecycle ref (§1.2), so the branches are mutually
exclusive by construction and the `elif` chain is exact.

**The exclusivity result.** If several authors append `claim_of: F`, the one with
the **lowest `seq`** wins. Every reader computes the same winner from the same
ordered, `recv`-stamped prefix:

> **Exactly-once claiming is a theorem of total order, not a lock** — given a
> single Δ (above), a complete prefix (§3, preamble), and `recv` rather than `ts`
> (§1.3). Remove any of those three and it is false.

No atomic endpoint, no leader election, no hot-path arbitration. A claimant
confirms it won by folding `ownership(F)` over **every** fact referencing F — `claim_of`, `release_of`, `resolves`, and any `_.tombstone`
naming F.

> A single-key filter such as `?refs.claim_of=<id>` is **not** sufficient for
> that confirmation, and a bus SHOULD NOT be described as making it cheap. The
> window hides releases, resolves and tombstones, so it returns the wrong answer
> in both directions: it reports a winner whose claim was already released, and
> it reports work as claimable that is already resolved or dead. The filter is
> useful for *finding* the claims on F; deciding the winner is §3's fold, over a
> complete prefix.

**Why expiry keys on `recv`.** A claim times out when time has provably advanced
past `claim.recv + Δ`. Wherever a later fact exists, the proof is that fact's own
bus-stamped `recv` — identical for every reader, so the fold is deterministic.
Only a *trailing* claim with no successor falls back to wall-clock `now`.

> **The trailing branch is advisory and MUST NOT be relied on for a terminal
> decision.** It can change `claimed(a)` into `open`, and where several claims
> trail it can change *which* author is reported. It exists to answer "should a
> new claimant try?", and a reader that needs a stable answer waits for the next
> fact, which settles it for everyone at once. v2.0 claimed this branch "only
> affects the advisory hint"; that was true of the state and false of the owner.

**To resolve, first claim.** A `resolves: F` is honoured **only** from F's
current claim winner. There is no ungated path.

v2.0 had one: a fact that had never been claimed could be resolved by any
author, as a convenience for "broadcast" facts anyone may close. That
convenience is a denial primitive. `resolved` is terminal, so a single
well-formed fact from any writer closes any never-claimed item permanently, and
nothing in the fold can distinguish it from a real completion. Meanwhile the
implementation had widened the branch further, honouring a stranger's resolve
whenever no claim was *live* — so a lapsed claim, which means the work needs
re-dispatch, could be closed by a passer-by.

Requiring a claim costs one append and states exactly the right thing: *I am
taking responsibility for this.* It also simplifies the fold — there is no
"was it ever claimed" flag to carry, and a `resolved` fact always names the
author who resolved it, where v2.0 returned `resolved(null)` and discarded the
resolver's identity on precisely the branch it blessed.

This is what makes crash recovery correct in both directions:

- A resolve issued *before* its claim expires is honoured and is terminal
  forever — timeout, a crash-recovery mechanism, never undoes a real completion.
- A claim that *did* time out is expired by the `recv` of the next claim, so the
  **re-dispatched** agent becomes the legitimate owner and its resolve is
  honoured. (A naive "first claimer, releases only" rule is wrong: a crashed
  claimer's stale claim would block the recovering agent forever.)

**Holding a long claim.** An agent whose work outlasts Δ MUST NOT release and
re-claim; it re-appends `claim_of: F` with a fresh `nonce` every Δ/3 or so. The
earlier claim expires at `recv + Δ` and the same author's later claim is then the
lowest live `seq`, so ownership continues with no race and no protocol change. If
the agent dies, renewal stops and the claim lapses on its own.

Accessors, for interoperability:

```
lifecycle(F)     = ownership(F)                            → open | claimed | resolved | dead
claimWinner(F)   = the author in claimed(a) or resolved(a); null for open and dead
didIWin(F, me)   = claimWinner(F) == me
```

### 3.5 Optional conventions

These are conventions layered on the same primitive: no new wire mechanics, no
reserved behaviour, no effect on §3.1–§3.4 or on the §9 vectors. An
implementation MAY ignore them entirely, and a reader MUST NOT treat their
absence as an error.

**Colony registry (`sys.registry`).** An agent MAY announce what it consumes and
emits, so a supervisor can close the loop between the two. `payload.interests` is
an array of §2.4 globs over fact types; `payload.publishes` is an array of types.
Both MUST be arrays of strings if present; a reader MUST ignore malformed
entries. `colony(prefix)` is the latest `sys.registry` per author, **excluding
authors whose latest registration is tombstoned** — that is how an agent leaves.
Ordering of the roster is the reader's choice and MUST NOT be locale-dependent;
implementations SHOULD sort by code point.

A fact type is an **orphan** when no registered agent's interest glob matches it:
output nothing is set up to consume. The reverse gaps are an interest matching no
fact (waiting on silence) and a declared `publishes` its author never emitted (a
silent producer). Reserved namespaces (§1.4) are excluded from orphan analysis.

**Context-sufficiency loop.** A fact may assert "X is broken" without enough
context to act on. The interested agent appends `context.requested` with
`refs.about` naming the thin fact and `payload.question`; any agent able to
answer appends `context.provided` with `payload.answer` and `refs.answers` naming
the request. A request is **answered** when at least one `context.provided`
carries `refs.answers == request.id`; `refs.parent` alone does not close it,
because `parent` means caused-by and a follow-up question is also caused by the
request.

See `docs/FACT-MODEL.md` for worked examples.

---

## 4. Identity & integrity

### 4.1 The content address

```
id = sha256( JCS( record ) )        rendered lowercase hex
```

where `record` is the JSON object built from the author-supplied fields, and
`JCS` is **[RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)**.

The record is:

```
{ "type": …, "author": …, "ts": …, "payload": … }
  + "refs":  present only if refs is non-empty
  + "nonce": present only if nonce is present
```

`seq`, `recv`, `sig` and `id` itself are excluded — they are bus-assigned, not
content. Because §1.1 rejects `""`/`null` refs values and non-object payloads at
append, there is **no normalization step**: the record is the submitted fields.
(v2.0 silently dropped empty refs values while hashing, which two implementations
had no way to agree on.)

**Why JCS.** v2.0 hand-rolled canonicalization in three sentences of prose and
got it wrong in every direction that matters: it described a Python-compatible
float rule that the reference implementation applied to exactly one key, left
every other number to whatever the host language's number formatter produced, and
never specified key-ordering or string escaping at all. Independent
implementations diverged on small exponents, large exponents, and non-BMP key
names. RFC 8785 already specifies all of it — number serialization (ECMAScript
`Number::toString`, shortest round-trip), property ordering (by UTF-16 code
units), string escaping, and whitespace (none) — and has tested libraries in
every language a second implementation would be written in. Adopting it deletes
the entire problem.

Consequences an implementer must notice:

- **All v2.0 ids change.** JCS emits no whitespace and does not render `ts: 100`
  as `100.0`.
- Key order is **UTF-16 code unit** order, per JCS. A Python implementation MUST
  NOT use bare `sorted()`, which orders by code point and differs for non-BMP
  keys.
- Non-finite numbers are not representable; §1.1 already rejects them.

### 4.2 The bus signature

```
sig = hmac_sha256( secret, "id|author|type|ts|recv|seq" )
```

with `ts` and `recv` rendered per JCS number formatting and `seq` as a decimal
integer.

A verifier recomputes the HMAC and compares in constant time. The key is
symmetric, so **only a holder of the secret can verify**: the bus on recovery, or
a replica that shares the secret. An unauthenticated reader cannot verify `sig`;
for it, `id` is the integrity check and `seq`/`recv` are trusted by trusting the
bus.

Two limits an operator must understand:

- **`sig` covers the header, not the content.** `payload` and `refs` are not in
  the signed message; they are covered by `id`, which the bus MUST re-verify on
  recovery (§7.1). A failing `sig` means the header was altered or the log was
  written under a different secret. It does not mean the payload is intact — that
  is what re-verifying `id` is for.
- **The delimiter is ambiguous.** `author: "a|b", type: "c"` and
  `author: "a", type: "b|c"` produce the same signing input. Since the HMAC is
  bus-only this is not an authentication bypass, but implementations SHOULD
  length-prefix the fields; a future revision will.

Operators MUST configure a stable secret. A bus that generates an ephemeral
secret at boot MUST report that it has done so (§2.5, `/info`), because every
signature written before a restart becomes unverifiable.

### 4.3 Idempotence

**Append is idempotent by `id`.** The bus keeps an `id → seq` index — rebuilt
from the log on recovery, a pure projection and never authoritative state — and
appending an `id` that already exists returns the existing `{seq, recv, sig}`
with `deduped: true` and HTTP `200`, without writing a second copy. "Resubmit is
safe" is the default, which is what lets a client retry an append through a
network failure without reasoning about it.

The sharp edge: a *legitimate repeat* — re-claiming F after releasing it, voting
the same way twice — would otherwise collapse into the original. An author
wanting a genuinely new action MUST make the content distinct, normally with a
fresh `nonce`. **Facts carrying a lifecycle ref or `vote` SHOULD always carry a
`nonce`.** This is exactly the model of a content-addressed store like git:
identical content is one object; change the content to get another.

---

## 5. Authorization — what a fact may assert about another fact

The bus does not adjudicate (§0.6) and authentication is out of scope (§5.4), so
any author can write any fact. That is not a gap to apologize for; it is the
consequence of §0.2. But it makes one question load-bearing, and v2.0 never
answered it: **when author M writes a fact about author A's fact, what must a
reader do with it?**

### 5.1 The gate table

A **fold gate** is a rule a reader MUST apply. An ungated key is *self-asserted*:
it says what its author believes, and readers weigh it.

| ref | gate a reader MUST apply |
|---|---|
| `resolves` | Honour only from the target's current claim winner. There is no ungated path — to resolve, first claim (§3.4). |
| `release_of` | Honour only from an author holding a live claim on the target. |
| `tombstones` | Honour only when `fact.author == target.author`. A tombstone by any other author MUST NOT retract the target; a reader MAY surface it as a *requested* retraction. |
| `vote` | Ignore when `vote.author == target.author` (§3.3). |
| `claim_of` | Not gated by identity — gated by **order**. The lowest live `seq` wins (§3.4). |
| `supersedes` | Honour only when `fact.author == target.author` (§3.1). A third party expresses staleness by contradicting (§3.3) or by writing to the register, not by retiring someone else's statement. |
| `parent`, `subject`, `about`, `answers` | Not gated. Self-asserted. |

The tombstone gate is new in v3.0 and it closes a real hole. In v2.0 any author
could tombstone any fact, and the effect was unusually destructive: the target's
lifecycle became `dead` — a **terminal** state — its register folded to `null`,
and compaction was then entitled to destroy its payload on disk. That is a
protocol-sanctioned data-destruction primitive available to every writer.
Retraction is now what it should be: **taking back your own statement.**

Operator-driven removal (legal takedown, GDPR erasure) is deliberately *not*
modelled as a fact. It is an out-of-band operation on the log, subject to §7.2.

### 5.2 Self-asserted links are claims, not proofs

`parent` and `subject` stay ungated on purpose, and a reader MUST NOT read either
as verified:

- `parent: P` asserts *"I was caused by P"*. It proves only that P exists exactly
  as named (§3.2). Any author may graft a fact onto any other author's trail.
- `subject: S` asserts *"this is about S"*. Anyone may write to any register;
  that is the point of a shared world, and the register's own ordering decides
  what is current.

Gating either would break the thing they are for — third-party observation — so
they are self-asserted and readers weigh them. The two keys that *retire* another
author's fact are gated instead (`supersedes`, `tombstones`, §5.1), because
retirement is not an observation about the world, it is an edit to someone's
statement.

The dividing line is worth stating plainly, since it is what makes the ungated
keys safe:

> **Adding to the world is open. Retiring someone else's statement is not.**

A reader that wants the stronger notion for an ungated key can compute it: both
facts carry `author`, so "child and parent share an author" is one comparison.

### 5.3 Deletion is a fact

The bus never mutates or silently drops a stored fact. Removal is an appended
`_.tombstone` whose `refs.tombstones` names the target, subject to §5.1.

Tombstoning and superseding are **different** and folds MUST tell them apart:

- **superseded** — a successor replaced this. The register moves on (§3.1); trust
  reports `superseded` (§3.3).
- **retracted** — the author takes this back. The register folds to `null`, not
  to the previous value; trust reports `retracted`; lifecycle is `dead` and
  terminal.

### 5.4 `author` is self-asserted

`author` is a string the writer chose. This protocol does not authenticate it and
has no notion of identity. Authentication is a transport concern — mTLS, a
gateway, an API key header — and a deployment MAY run the bus on a trusted
network or behind a proxy that validates or stamps `author`.

> A bus that is reachable by an untrusted party has no integrity story for
> `author`, and therefore none for §3.3 or §3.4. A public deployment SHOULD
> authenticate writers and SHOULD NOT expose write access unauthenticated.

Nothing in the fold layer can compensate for this, and readers SHOULD NOT pretend
otherwise: every guarantee in §3 is relative to the honesty of the `author`
field, except the ordering results in §3.4, which hold regardless.

---

## 6. What the bus enforces

Deliberately minimal: enough to keep an append-only log from being weaponized
into unbounded growth, unbounded work, or nonsense that no reader can fold.
Everything else is a reader concern.

### 6.1 Well-formedness

A bus MUST reject, with `400`, any fact violating §1.1's presence, type or domain
rules; carrying more than one lifecycle ref (§1.2); or exceeding a §8 limit
(`413`). This is not decoration: v2.0 checked three fields for truthiness, so a
`ts` of `1e999` became `null` on disk and permanently broke that fact's own
content address, and a numeric `type` crashed several folds.

### 6.2 Causation depth

A bus MUST reject a fact whose causation depth exceeds a configured maximum
(default 64, §8), where depth is computed by walking `refs.parent` through facts
**present in the log at append time**, counting the new fact as depth 1 when its
parent is absent or unnamed. A fact whose depth is exactly the maximum is
accepted; `depth > max` is rejected.

> **This bounds the walk, not the chain.** A `parent` MAY name a fact that is not
> present (§3.2), so an author can construct an arbitrarily deep chain by
> appending it leaf-first and letting the ancestors arrive afterwards. That is
> permitted — append order must not determine validity in a log that is read by
> cursor — and it means §6.2 is a cheap bound on *work at append time*, not a
> guarantee about the depth of any trail a reader will later fold. Readers MUST
> bound their own walks (§3, preamble). v2.0 presented this rule as a safety
> guarantee; it is a rate-limiter.

**Cycles.** A `refs.parent` cycle cannot be constructed through a conforming bus:
closing a loop A→B→A requires A's `id` — and therefore A's frozen content, which
already names B — before A is hashed, i.e. a sha256 pre-image. This argument is
sound for appended facts and unsound for everything else: exported, replicated,
truncated and hand-repaired logs exist. It is why §3 requires folds to terminate
regardless, and why the bus's own depth walk MUST be bounded.

### 6.3 Admission rate

A bus MAY apply a per-author token bucket and a global cap to bound log growth.
Rejections are facts-not-written, never state mutations. **No default is
specified**, because a default for an optional mechanism is a promise the
protocol does not keep; an implementation that offers rate limiting MUST document
its own defaults and expose them (§2.5).

---

## 7. Storage & recovery

### 7.1 The log

The bus is an append-only log — one JSON record per line — written in `seq`
order. `recv` MUST be non-decreasing in `seq`.

**Recovery.** Read the log in order.

- On a **torn final record** — a trailing byte range that does not parse — the
  bus MUST **truncate the file to the last byte offset that parses** before
  accepting any append. Skipping the fragment and appending after it is not
  sufficient: the new record is concatenated onto the fragment, the combined line
  does not parse, and an acknowledged fact is silently lost on the next restart
  while its `seq` is handed to different content. That breaks the total order
  that everything in §3 rests on, and it is the single most severe defect this
  version fixes.
- On a **corrupt record that is not the final one**, the bus MUST NOT start
  normally. It MUST report the offset and require an explicit repair action.
  Silently skipping an interior record renumbers nothing but removes a fact that
  other readers have already folded, permanently forking their view.
- The bus MUST re-verify `id == hash(record)` while recovering, and MUST report
  the count of failures (§2.5). §4.2's `sig` does not cover content, so this is
  the only check that detects on-disk payload tampering.
- `seq` is restored as the **maximum** `seq` present. A bus MUST NOT reuse a
  `seq`, ever, including after a truncation or a repair.

There is no in-memory state machine to rebuild: the log *is* the state, and the
derived indexes (the `seq` counter, the `id → seq` map) are pure projections.
That is the reliability dividend of §0.6.

### 7.2 Compaction

Compaction reclaims space. Its one binding rule:

> **Compaction MUST NOT change the result of any §3 fold.**

Concretely, a compactor:

- MUST retain the full skeleton `{id, seq, recv, author, refs, sig}` of every
  fact. Every fold depends on it: trails need `refs.parent`, the claim winner
  needs `seq` + `author` + `refs.claim_of`, trust needs `author` + `refs.vote`.
- MUST NOT drop the `payload` of a fact whose payload a fold reads. That is at
  minimum every `_.vote` (§3.3 reads `payload.verdict`) and every fact returned
  by `current(S)`.
- MUST NOT treat supersession alone as grounds for dropping a payload. Only
  **retraction** (§5.3) is. A superseded fact is still a member of
  `history(S)`, which §3.1 explicitly supports readers accumulating over — v2.0's
  compactor stripped every non-head member of every register, destroying exactly
  the use case the register chapter recommends.
- MUST write to a temporary file, fsync it, rename atomically, and fsync the
  containing directory.

**A compacted fact no longer hashes to its own `id`.** This is unavoidable —
dropping a payload changes the content — and it means a stripped fact's content
address is a historical name rather than a live checksum. An implementation MUST
therefore mark a fact whose payload was dropped, so a reader can tell "verified"
from "unverifiable" instead of concluding the log was tampered with. A reader
MUST NOT report a compacted fact as an integrity failure.

Given the above, operators should treat compaction as a retention policy applied
to retracted content, not as a general space optimization. A log that must shrink
further should be truncated at a checkpoint and archived, which loses old prefixes
honestly rather than corrupting the folds over them.

### 7.3 Replication and scale

**Total order implies a single logical appender.** `seq` is one global sequence,
so all writes funnel through one append point. High availability is therefore
single-writer with failover (e.g. Raft replicating the append position), **not**
multi-master: there is no way to merge two independent orders without losing
§3.4. Reads scale out freely across replicas.

A deployment that genuinely needs multi-region writes must shard into
independent buses. A shard key is safe only if it keeps every fact together with
every fact that references it. **`type` is not such a key**: a `_.claim` carries
its own type, so a claim and its target land in different shards and §3.4 breaks
*inside* every shard, not merely across them — the same is true of `_.vote` and
§3.3, and of `_.tombstone` and §3.1. Sharding by `subject` is safe only for
facts that carry one, which excludes every lifecycle fact. In practice, shard by
a durable partition of the world that the writers agree on out of band, keep each
target and all facts referencing it in one shard, and accept that no §3 result
holds across shards.

A bus MAY serve a **materialized view** of a §3 fold as a cache. There is no
such thing as "the" fold, though: `trust` takes the reader's quorum and
`ownership` takes a wall clock, so a view MUST be parameterized by the values it
was computed with and MUST be byte-identical to a client-side fold **using those
same parameters** over the same prefix. A bus MUST NOT publish a view under
implicit defaults, because a reader cannot tell whose policy it is looking at,
and a served-by-default fold is the adjudication §0.6 forbids. A view is never a
second source of truth (§2.5).

---

## 8. Parameters

| parameter | default | who sets it | note |
|---|---|---|---|
| **Δ — claim timeout** | 600 s | **the log** | §3.4. Published via `/info`; readers MUST use the published value and MUST NOT override it. |
| Trust quorum | 2 | the reader | §3.3. MUST be ≥ 1. |
| Causation depth cap | 64 | the operator | §6.2. Bounds append-time work, not trail depth. |
| Read `limit` default / max | 100 / 10 000 | the operator | §2.2. |
| Max `payload` (serialized) | 1 MiB | the operator | §1.1, `413`. |
| Max `refs` keys | 64 | the operator | §1.1. |
| Max `type` / `author` / `subject` | 256 B each | the operator | §1.1. |
| Max `nonce` | 128 B | the operator | §1.1. |
| Max glob pattern | 256 B | the operator | §2.4. Rejected with `400`; the pattern is attacker-supplied. |
| Max `interests` / `publishes` entries | 64 each | the operator | §3.5. Each entry is a glob every reader evaluates. |
| Durability | fsync per append | the operator | §7.1. A relaxed policy (per-batch, per-second) MAY be offered and MUST be reported via `/info`, because it changes what a `201` means. |
| Admission rate | none | the operator | §6.3. No protocol default. |

A bus MUST expose its effective values (§2.5). Note how little is configurable in
the trusted core — another consequence of §0.6. Δ is the one parameter that is
neither a reader's nor purely an operator's choice: it is part of the meaning of
the log, and it must be the same for everyone reading it.

---

## 9. Conformance

There are three conformance targets, and an implementation MUST state which ones
it claims.

**A conforming bus** implements §0.6's four duties, §1.1's validation, §2.1–§2.4,
§4, §6 and §7. It MAY ignore every read filter (§2.2). It MUST NOT serve an
operational endpoint that changes a fold result (§2.5).

**A conforming reader** implements the folds of §3.1–§3.4 exactly, over a
complete prefix, with the bus-published Δ. §3.5 is optional.

**A conforming client** obeys the authoring rules: field domains (§1.1), one
lifecycle ref per fact (§1.2), a `nonce` on repeatable relational facts (§4.3),
and `refs.subject` on any fact intended to become a register's current value
(§3.1).

### 9.1 The vector set

A canonical cross-language conformance vector set ships with this protocol. It is
the interop contract; prose is not. A vector set MUST pin, at minimum:

- **§4** — for each vector, the exact JCS canonical string and the resulting
  `id`. Coverage MUST include: nested key sorting; a non-BMP key (the UTF-16 vs
  code-point ordering hazard); numbers at `1e-7`, `1e-6`, `1e16`, `1e21`, and an
  integer beyond 2^53; a whole-number `ts`; `ts` of `-0`; unicode strings
  requiring escaping; a lone surrogate; absent vs empty `refs`; present vs absent
  `nonce`.
- **§3, every normative fold** — `history`, `current`, `supersededBy`,
  `isSuperseded`, `chain`, `descendants`, `trust`, `ownership`/`lifecycle`,
  `claimWinner`. A fold declared normative with no vector is not part of the
  contract in practice.
- **The cases where two readings diverge**, which is what a vector is *for*:
  a subject group of at least four members (to distinguish "immediate successor"
  from "latest"); two explicit successors of one fact; a register head retracted;
  a non-head member retracted; a claim expiring exactly at the Δ boundary and one
  past it; a resolve from a stranger after a claim lapsed; a resolve on a
  never-claimed fact; a release by a non-holder; a chain with a dangling ancestor
  (the gap marker); `descendants` over a fork; a vote with an unrecognized
  verdict; a self-vote; `trust` of a retracted fact; `quorum = 1`.

A cross-language verifier MUST check fold outputs, not only hashes. A verifier
that reproduces every `id` while checking no fold result gives no evidence about
§3, which is where all the meaning is.

Changing a committed vector is a **wire-breaking change**: it MUST be deliberate,
reviewed hash by hash, and declared in the commit that makes it.

---

## 10. Lineage

| source | what this protocol takes |
|---|---|
| **Blackboard architecture / stigmergy** | a shared medium everyone writes observations to and nobody is addressed through — ants read the ground, not each other. The board is kept; the control component is dropped, because the total order arbitrates. |
| **Event sourcing / CQRS** | the log is the only truth; every state is a projection. |
| **Git** | content addressing, immutability, append-only, fetch-by-cursor; identical content is one object. |
| **Lamport / total order** | exclusivity as a theorem of order rather than a lock. |
| **CAN bus** | content-addressed broadcast with local filtering; no node is addressed. |
| **RFC 8785 (JCS)** | canonical JSON, so that "the same fact" means the same bytes in every language. |
| **Scientific method** | contestable statements, corroborated or contradicted, with no central arbiter of truth. |

---

*Protocol v3.0 by Carter.Yang. The bus orders and preserves; readers decide
meaning. Keep the trusted core small enough that a second implementation is a
weekend, and let the conformance vectors — not this document — guarantee interop.*
