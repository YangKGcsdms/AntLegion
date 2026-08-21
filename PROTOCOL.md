<div align="center">

🌐 **English** · [简体中文](PROTOCOL.zh-CN.md)

</div>

# AntLegion Protocol — v3.0

> One primitive. One write. One read. Everything else is derived.
>
> **A fact log that shares world state between agents.**
>
> Designed by **Carter.Yang**, re-derived from first principles, 2026.

---

## Abstract

Software agents that share no process — different machines, different runtimes,
different vendors — have no way to agree on what is true. Each holds its own
picture, and a human copies state between them.

This protocol replaces that relay with a **shared world-state log**. Agents
append immutable, content-addressed **facts** to a single append-only log that
assigns a total order. No fact is addressed to anyone. Every reader **folds** the
same log into the same world: what X is right now, how it came to be and what it
led to, whether to believe it, and who is responsible for it.

The bus does four things — order, witness, sign, preserve — and holds no
per-fact state. All meaning lives in reader folds, which are pure functions of a
log prefix. Because the order is total and the folds are pure, two readers that
have seen the same prefix compute the same world; and exactly-once assignment of
work falls out as a **theorem of that order** rather than a lock: the lowest-`seq`
live claim wins, and every reader computes the same winner without asking anyone.

**Status: draft.** Not wire-compatible with v2.0 (§C).

---

## Status of this document

**Version 3.0. Stability: draft.**

The normative sections are §5 (fields), §7 (operations), §8 (folds), §10
(authorization and enforcement) and §11 (storage). §8 is where conformance
actually lives, because the bus is stateless: an implementation that serves
§7 perfectly and folds §8 differently is not interoperable in any useful sense.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, RECOMMENDED,
MAY and OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174,
when and only when they appear in all capitals.

**This version is not wire-compatible with v2.0.** Content addresses change,
several folds are tightened, and the bus rejects inputs it previously accepted.
See §C for the full change list and the migration position.

---

## 1. Introduction

### 1.1 The problem

Two agents are working in the same world and share nothing else.

One is a coding session on a laptop. One is a job in CI. One is a resident
process on a server, one is a hosted agent at a vendor. They do not share memory,
a process tree, a scheduler, or a framework. They may not share a language or a
company.

They still need to agree on the state of the world they both act on: which build
is deployed, whether the migration ran, what the customer said, which of them is
handling the incident. Today the thing carrying that state between them is a
person, pasting from one window into the next.

Inside one process tree this problem does not exist — there are subagents,
shared memory, a supervisor. Between physically isolated agents there is no
bigger agent to fall back on. **There is a human relay.**

### 1.2 Why existing approaches do not fit

Each of the obvious mechanisms solves a neighbouring problem and fails this one
for a structural reason, not an incidental one.

| mechanism | what it gives | why it is not this |
|---|---|---|
| **Message queue** | delivery to a consumer | messages are *consumed*: after delivery the state is gone from the medium and lives in the consumer. A late-arriving agent cannot reconstruct the world. Delivery also implies a recipient, and a recipient implies a command. |
| **Shared database** | a current value | the current value is all you get. How it came to be, who else believes it, and whether it was contested are not recoverable, because writing is destructive. |
| **Orchestrator / workflow engine** | assignment and sequencing | someone must hold the plan. That someone is a bigger agent, which is exactly what does not exist between organizations — and every participant must accept its authority. |
| **Event bus (pub/sub)** | broadcast | no total order across subscribers and no durable prefix, so two subscribers legitimately disagree and neither can prove which is right. |
| **CRDT / state-based replication** | convergence without coordination | convergence is bought by restricting what can be *said* until every operation commutes. Disagreement — "A says 3, B says 7" — is the thing we need to represent, not the thing to design away. |

What is left when you subtract all of it: a medium that **keeps** everything,
**orders** everything, and **commands** nothing.

### 1.3 The derivation

The design is not a set of choices. Each step below is forced by the previous
one, and the whole protocol is what remains.

**1. The observation must be written where both can see it.** If A tells B
directly, C — who has not been born yet — cannot learn it. So there is a medium,
and it is written to, not sent through.

**2. The medium carries facts, not commands.** A command names a recipient and
implies delivery semantics: *was it received, by whom, what if they are gone.*
The moment the medium owes anyone delivery, it owes them liveness, retries and
identity, and it has become a queue with an orchestrator attached. A fact names
only the world. `refs` therefore names **a fact, or a piece of the world — never
a party**, and there is no field in which a recipient could be written even by an
author who wanted to (§5.4).

*(This is the structural argument. The weaker one — "addressing is
unrepresentable" — is false: an author can put anything in a payload. What is
unrepresentable is a delivery obligation, because nothing in the protocol ever
reads a fact on anyone's behalf.)*

**3. Writing observations is not enough; readers must be able to compute
"now".** Two agents both write readings for `deploy:prod`. Something must decide
which is current, and it must be a rule both compute rather than a value someone
holds — otherwise we are back to a shared database (§1.2). So there is a
**fold**: a pure function from the log to an answer.

**4. A fold is only shared if the input is ordered.** Two readers folding the
same *set* of facts in different orders get different answers. So the medium
assigns a **total order**, and it is the only thing the medium decides.

**5. The order must be witnessed, not claimed.** If authors number their own
facts they can collide, lie, or reorder. So a single component assigns `seq`, and
the same component stamps the time it saw each fact (`recv`) and signs the pair.
That component is the **bus**, and this is nearly all it does.

**6. Nothing may be rewritten.** A fold over a log whose past changes is not a
function of anything. So the log is **append-only** and facts are **immutable**;
correction is a new fact that supersedes (§8.1), and removal is a new fact that
retracts (§10.1).

**7. Identity must come from content.** Immutable records need names that cannot
drift from what they name, and two agents that have never met must agree on
whether they hold the same fact. So `id = sha256(canonical(content))` — the
content address (§5.9). A repeat of identical content is the same fact, which
makes append idempotent for free (§9.4).

**8. Responsibility is then already solved.** Ask "who is handling F" and the
answer is a fold like any other: the lowest-`seq` live claim on F. Because the
order is total, every reader computes the same winner without asking anyone.
Exactly-once assignment is a **corollary of sharing a world**, not the purpose of
the design (§9.1).

That is the entire protocol: an ordered, append-only log of immutable
content-addressed facts, a bus that orders and witnesses, and reader folds that
carry all the meaning.

**The four questions.** Everything an isolated agent needs from a shared world is
one of four questions, and each is a fold over the same stream. They are
presented throughout this document in the order an agent actually needs them:

| # | question | fold | § |
|---|---|---|---|
| 1 | **what is X right now** | the subject register | §8.1 |
| 2 | **how did this come to be · what did it lead to** | the causal trail | §8.2 |
| 3 | **should I believe it** | trust | §8.3 |
| 4 | **who is responsible for it** | ownership | §8.4 |

Question 4 is **a corollary, not a purpose**. Responsibility for a fact is just
another piece of world state, and because the world is totally ordered the answer
happens to be unambiguous — which yields exactly-once claiming for free (§9.1).
That result is genuinely useful and it is fully normative here, but it is the
*last* thing the log is for, not the first. A stream with no `_.claim` in it is a
perfectly good world.

### 1.4 Contributions

1. A **fact** with a strict author/bus field split (§4.2), from which content
   addressing, idempotence, and the trust asymmetry between `ts` and `recv` all
   follow as consequences rather than rules.
2. **Four normative folds** (§8) covering the four questions an isolated agent
   actually asks, defined over a complete log prefix, with invariants and a state
   transition table.
3. An **authorization model** (§10.1) stating, per `refs` key, whether a link is
   self-asserted or fold-gated — and therefore what an author can and cannot do
   to someone else's fact.
4. **Proofs** (§9) of exclusivity, determinism, monotonicity and idempotence,
   each with its premises exposed and its boundary stated.
5. A **conformance vector set** (§A) that pins folds and not merely hashes, since
   the folds are where the meaning is.

### 1.5 Non-goals

Stating these is not modesty; each one is a thing the design deliberately does
not buy, and an implementation that adds it silently is not this protocol.

- **Not a message queue.** Nothing is consumed, nothing is delivered, no fact is
  addressed. There are no consumer groups and no acknowledgements.
- **Not an orchestrator or workflow engine.** The log has no steps, no
  assignments, no scheduler and no plan. A pipeline is a shape a reader folds out
  of the trail afterwards, never a state anyone holds.
- **Not an agent framework.** This protocol says nothing about how an agent
  decides, what model it runs, or how it is deployed.
- **Not a consensus protocol.** There is one bus (§2.4). This protocol does not
  replicate a decision across mutually distrusting replicas, and §8.3's trust
  fold is explicitly *not* consensus — quorum is the reader's policy (§8.3).
- **Not an identity or authentication system.** `author` is a self-asserted
  string (§10.1). Authenticating writers is a transport concern.
- **Not a permission system.** Every writer may write anything the field domains
  allow. The gates in §10.1 constrain what a fact *means to a reader*, never who
  may append.
- **Not storage for large objects.** `payload` is capped (§B); large content
  belongs elsewhere, named from a payload.

---

## 2. System model

Everything this protocol guarantees is guaranteed *relative to this model*. A
deployment that violates an assumption here does not get a degraded version of
the guarantees in §9 — it gets none of them, and §9 says which.

### 2.1 Participants

| participant | what it is | what it may do |
|---|---|---|
| **Author** | any process that appends. Identified by a self-asserted `author` string. | submit a fact for append. Nothing else — an author has no privileged operation, and no author is distinguished by the protocol. |
| **Bus** | the single trusted component. | assign `seq`, stamp `recv`, sign, persist, serve a range. §1.3's four duties, and nothing more. |
| **Reader** | any process that reads and folds. | fetch a prefix by cursor and evaluate §8. A reader asks the bus for bytes, never for meaning. |

One process is normally all three. The roles are separated here because the trust
statements differ per role, not because the deployments do.

### 2.2 The trust boundary

The boundary runs through the middle of every fact:

- **Author-domain fields are untrusted.** `type`, `author`, `ts`, `payload`,
  `refs`, `nonce` are whatever the writer typed. The bus does not evaluate them
  for truth and MUST NOT reject a fact for being *wrong* — only for being
  malformed (§10.2). A reader MUST NOT treat any of them as attested.
- **Bus-domain fields are trusted.** `seq`, `recv`, `sig` are assigned by the bus
  under its own authority, and `sig` proves it. Every time-based fold keys on
  `recv`, never on `ts`, for exactly this reason (§5.6/§5.7).
- **`id` is trusted differently.** It is neither asserted nor witnessed: it is
  *recomputable*. Any holder of the record can verify it without trusting anyone,
  which is why it — and not `sig` — is what protects `payload` (§5.10).

The consequence is stated once and applies everywhere: **every guarantee in §8 is
relative to the honesty of `author`, except the ordering results of §8.4, which
hold regardless** (§9.1).

### 2.3 The failure model

**Assumed, and handled:**

| failure | how the protocol survives it |
|---|---|
| An author crashes mid-work | its claim lapses after Δ and the work is re-dispatchable, without un-doing a completed resolve (§8.4, §9.3) |
| An author crashes mid-append | append is idempotent by `id`, so the retry is the same fact (§9.4) |
| The network drops or duplicates a request | same as above; a duplicate is a no-op returning the original |
| The bus crashes | the log is the state; recovery replays it and rebuilds only pure projections (§11.1) |
| The bus crashes mid-write | a torn tail is truncated to the last record that parses (§11.1) |
| A reader is arbitrarily slow or restarts | folds are functions of a prefix, so a reader resumes from a cursor and converges (§9.2) |
| Clocks are unsynchronized or wrong | no fold reads `ts`; `recv` comes from one clock (§5.8, §9.1) |
| An author lies in `payload` | not prevented. Surfaced: §8.3 lets other authors contradict it |
| An author forges `author` | not prevented, and §8.3 is void under it (§2.2, §12) |
| On-disk corruption of a payload | detected on recovery by re-verifying `id`, and reported (§11.1) |

**Assumed, and NOT handled:**

- **A Byzantine bus.** The bus is trusted to order honestly and not to forge.
  Nothing in this protocol detects a bus that reorders, drops, or fabricates
  facts. A client cannot even verify `sig` (§5.10).
- **Network partition of the bus.** There is one bus (§2.4). Under partition,
  writers on the far side cannot append. This protocol offers no availability
  story for that case.
- **A confidentiality boundary between authors.** Every reader of the log reads
  everything on it.
- **Time synchronization between authors.** Not assumed, and not needed — the
  design's answer is to fold on `recv` rather than to require synchronized
  clocks.
- **Reader resource exhaustion.** §8.0 requires a complete prefix for any
  normative result, and §11.2 forbids compaction from changing a fold's answer,
  so it reclaims payloads and never skeletons. Together these put a floor under
  every conforming reader: it must retain the skeleton of every fact ever
  appended, and that floor grows monotonically with the age of the log. Nothing
  in this protocol bounds it. Folds are defined over the whole prefix as well,
  so a reader answering K questions about N facts does O(K·N) work unless it
  implements them incrementally. This is the price of §2.2's split — a stateless
  bus buys agreement by making every reader carry the world — and it is listed
  as a failure mode because a long-lived deployment meets it in production
  rather than reading about it here.

**Mitigations, all of them conforming.** §8 specifies answers, not algorithms
(§8.0), so a reader MAY compute them however it likes as long as it returns what
§8 says it returns:

- **Fold incrementally.** Every fold in §8 is defined over indexes a reader can
  maintain online as facts arrive — the highest-seq member per subject, the live
  claims per target, the votes per target, the children per parent — rather than
  rescanning the prefix per question. The per-question cost then falls from
  O(N) to the size of the answer.
- **Checkpoint the derived state.** A reader MAY persist that state at `seq` N
  and resume at N+1. A checkpoint is private derived data, never a fact, and it
  is valid only for the parameters it was computed with: a reader MUST discard
  and recompute it if Δ or a quorum it depends on changes (§B).
- **Share a smaller world.** §2.4 permits independent logs for independent
  subject spaces. Splitting there is the only one of the three that lowers the
  floor rather than the work, because a reader then retains one world instead of
  all of them.

None of these permits folding a filtered, sampled or gap-containing window and
presenting the result as normative (§8.0).

### 2.4 The single-bus assumption

**One log, one bus, one total order.** Every guarantee in §9 rests on this. It is
the load-bearing assumption of the whole design and it is stated here rather than
implied because it bounds where the protocol may be used.

What it costs: the bus is a single point of failure and a throughput ceiling. A
deployment needing more than one bus has **more than one world**, and this
protocol says nothing about reconciling them.

What it buys: no consensus round, no vector clocks, no conflict resolution, no
leader election, and — because a single writer assigns a dense total order —
exclusivity as arithmetic rather than as a lock (§9.1).

Two extensions preserve the assumption and are permitted:

- **Read replicas.** A replica that receives the log in `seq` order and serves
  reads is sound: folds are pure functions of a prefix, and a replica lagging by
  N facts is a reader at an earlier prefix, which §9.2 already covers. A replica
  MUST NOT accept appends.
- **Sharding by world.** Independent logs for independent subject spaces are fine
  and are simply separate worlds. A fold MUST NOT span two logs: `seq` is
  meaningful only within one log, so there is no order to fold over.

Anything that makes two components assign `seq` for the same log is a different
protocol, and this document does not describe it.

---

## 3. The blackboard and what sits on it

### 3.1 The blackboard

The mental model is the classical **blackboard architecture**, minus its control
component.

A blackboard is a shared surface that specialists write partial results onto;
each specialist watches the board and contributes when it sees something it can
act on. Nobody is called. In the 1970s formulation a *control component* decided
which specialist ran next — and that component is exactly the bigger agent that
does not exist between organizations (§1.2). Here the **total order arbitrates**
instead: where classical blackboards needed a scheduler to prevent two
specialists from doing the same work, ordering makes the answer computable by
each of them independently (§9.1).

The same shape appears in nature as **stigmergy**: an ant deposits pheromone on
the ground and every other ant reads the ground. No ant instructs another; the
medium carries the state, and coordination is a consequence of reading the same
medium. This is the protocol's guiding image, and it is a strict one — anything
that would make one participant direct another is out of scope by construction.

### 3.2 The fact

> A **fact** is an immutable, content-addressed record of something an author
> observed or decided, placed at a unique position in a single total order by a
> trusted bus.

Four properties, each doing work:

- **Immutable** — so a fold is a function of the log rather than of when it ran.
- **Content-addressed** — so its name cannot drift from its content, and two
  agents that have never met agree on whether they hold the same fact.
- **Uniquely positioned** — so any two facts have a defined precedence, which is
  what makes exclusivity computable.
- **A statement, not an instruction** — so nothing on the log is owed to anyone.

A fact is not a message, an event, a task, or a row. It is a statement that
something was observed or decided, and it remains true that it was stated even
after it is superseded or retracted.

### 3.3 Glossary

Terms are used in exactly these senses throughout.

| term | definition |
|---|---|
| **fact** | §3.2. The single primitive. |
| **bus** | the one component that assigns the total order (§2.1). |
| **author** | the self-asserted string identifying who appended a fact; also the process itself. |
| **reader** | any process evaluating a fold. Not a role the bus knows about. |
| **log** | the totally ordered, append-only sequence of all facts. |
| **prefix** | all facts with `1 ≤ seq ≤ N`, for some N. The domain of every fold (§8.0). |
| **complete prefix** | a prefix with no gaps. Folding anything else yields a non-normative approximation. |
| **fold** | a pure function from a complete prefix (and parameters) to an answer. Where all meaning lives. |
| **register** | the set of facts sharing a `refs.subject`, and the latest-wins value folded from it (§8.1). |
| **subject** | a **world name** — an opaque string naming a piece of the world, agreed out of band. Not a fact id. |
| **trail** | the transitive `refs.parent` structure, walked backward (`chain`) or forward (`descendants`) (§8.2). |
| **gap marker** | an explicit placeholder for an ancestor not present in the prefix (§8.2). |
| **claim** | a fact carrying `refs.claim_of`, asserting responsibility for the target. |
| **claim winner** | the author of the lowest-`seq` live claim on a target (§8.4). |
| **live claim** | a claim not yet expired under Δ, not released, on a target not yet resolved or retracted. |
| **Δ (delta)** | the claim timeout, in seconds. A property of the log, published by the bus (§B). |
| **superseded** | replaced by a successor. The register moves on; the fact remains on the log (§8.1). |
| **retracted** | taken back by its own author via `_.tombstone`. Distinct from superseded (§10.1). |
| **lifecycle ref** | one of `claim_of`, `resolves`, `release_of`, `tombstones`. A fact carries at most one (§5.4). |
| **author domain** | the fields the author writes, which enter the content hash and are untrusted (§4.2). |
| **bus domain** | the fields the bus writes, which do not enter the hash and are trusted (§4.2). |
| **content address** | `id` — `sha256(JCS(record))` over the author domain (§5.9). |
| **terminal state** | a lifecycle state no later fact can change: `resolved`, `dead` (§8.4). |
| **conforming reader** | one that implements §8.1–§8.4 exactly, over a complete prefix, with the bus-published Δ (§A.1). |

---

## 4. The structure of a fact

### 4.1 Field overview

```jsonc
{
  "seq":    1337,            // bus: position in the total order
  "recv":   1748300000.4,    // bus: witnessed arrival time
  "id":     "b3f1…",         // sha256(JCS(author-domain fields))
  "type":   "deploy.status", // author: dotted taxonomy
  "author": "ci@build-7",    // author: who says so
  "ts":     1748300000,      // author: when they say it happened (advisory)
  "payload": { "v": 42 },    // author: what they say
  "refs":   { "subject": "deploy:prod" },  // author: what it is about
  "nonce":  "k7x9",          // author: optional, forces a distinct id
  "sig":    "hmac…"          // bus: signature over the header
}
```

| field | written by | presence | in the hash | trust |
|---|---|---|---|---|
| `type` | author | REQUIRED | yes | untrusted |
| `author` | author | REQUIRED | yes | untrusted |
| `ts` | author | REQUIRED | yes | untrusted |
| `payload` | author | REQUIRED | yes | untrusted |
| `refs` | author | OPTIONAL | yes, when non-empty | untrusted |
| `nonce` | author | OPTIONAL | yes, when present | untrusted |
| `id` | either | REQUIRED on a stored fact | — (it *is* the hash) | **recomputable** |
| `seq` | bus | assigned | no | trusted |
| `recv` | bus | assigned | no | trusted |
| `sig` | bus | assigned | no | trusted |

### 4.2 The two domains

The nine fields are not a flat list. They are a **partition**, and it is the
organizing principle of the whole format:

> **A line on the blackboard is written by two hands.**
> The author writes the content; the bus stamps a seal beside it.

| | **author domain** | **bus domain** |
|---|---|---|
| fields | `type` `author` `ts` `payload` `refs` `nonce` | `seq` `recv` `sig` |
| enters the content hash | **yes** | **no** |
| trust | **untrusted** (forgeable) | **trusted** (bus-signed) |
| fixed | before append | at append |

This one split answers four of the format's hardest questions at once, and they
are not four rules — they are four consequences of the same rule:

| question | answer given by the split |
|---|---|
| Why does `id` hash only some fields? | The bus domain must be outside the hash. Otherwise `seq` depends on `id` and `id` depends on `seq` — a circular definition with no fixed point. |
| Why does a resubmit deduplicate? | Same author domain ⇒ same `id` ⇒ the bus recognizes the same fact (§9.4). |
| Why does `nonce` exist at all? | It is the author's only means of **deliberately changing the author domain** to obtain a new `id` when the rest of the content is identical. |
| Why is `ts` advisory and `recv` authoritative? | One is in the author domain, one in the bus domain. It is not a recommendation to prefer `recv`; only `recv` is structurally trustworthy (§5.7). |

`id` sits outside both domains on purpose: it is a *function* of the author
domain, so it is neither asserted nor witnessed but **recomputable by anyone**.
That is why `id`, not `sig`, is what protects `payload` (§5.10).

---

## 5. Field specifications

Each field is specified with the same six properties, then its meaning, an
example, the design rationale, and its constraints. The rationale is written as a
refutation rather than a statement — *what breaks if you remove this* — because
that is the form that tells an implementer which parts may be compromised and
which cannot be touched at all.

### 5.1 `type`

| type | written by | presence | in the hash | trust | limit |
|---|---|---|---|---|---|
| string | author | REQUIRED | yes | untrusted | ≤ 256 bytes UTF-8 |

**Semantics.** A dotted taxonomy label naming the *kind* of statement, so readers
can filter a stream cheaply without parsing payloads.

**Example.** `"deploy.status"`, `"build.failed"`, `"_.claim"`.

**Design rationale.** Remove `type` and every reader must parse every `payload`
to decide whether it cares — the read filter of §7.3 collapses, and a stream a
reader could have skipped becomes a stream it must deserialize. Make it free-form
instead of constrained and glob filtering becomes ambiguous: `deploy.*` cannot
mean anything definite when a type may contain `*` or a newline. v2.0 imposed no
character rule at all, and a numeric `type` crashed several folds.

**Reserved namespaces.** These prefixes are reserved by this protocol. Authors
MUST NOT mint types under them except as defined here, and readers MUST NOT
assign them application meaning:

| prefix | owner | defined members |
|---|---|---|
| `_.` | this protocol | `_.claim`, `_.resolve`, `_.release`, `_.vote`, `_.tombstone` |
| `sys.` | operational conventions | `sys.registry` (§8.5) |
| `context.` | the clarification convention | `context.requested`, `context.provided` (§8.5) |

**Constraints.**

- An author MUST supply `type`.
- It MUST be a non-empty string of dotted segments matching
  `[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*`, at most 256 bytes UTF-8.
- A bus MUST reject a violation with `400` (`413` if only the length is
  exceeded).
- A fold keying on a reserved type MUST key on the `type` field, not merely on
  the presence of a `refs` key: a `_.tombstone` is recognized by
  `type == "_.tombstone"` **and** `refs.tombstones`; a `_.vote` by
  `type == "_.vote"` **and** `refs.vote`. Claims, resolves and releases are
  recognized by their lifecycle ref, and their `type` SHOULD be the reserved one
  but MUST NOT be required to be.
- Facts under a reserved namespace are **not** members of a subject register
  (§8.1).

### 5.2 `author`

| type | written by | presence | in the hash | trust | limit |
|---|---|---|---|---|---|
| string | author | REQUIRED | yes | **untrusted** | ≤ 256 bytes UTF-8 |

**Semantics.** An opaque string naming who appended the fact. The protocol
imposes no structure and performs no authentication (§10.1, §12).

**Example.** `"ci@build-7"`, `"sensor-3@node-a"`.

**Design rationale.** Remove `author` and three folds lose their meaning at once:
§8.3 cannot ignore self-votes or count distinct voters, §8.4 cannot tell whose
claim won or whether a resolve came from the winner, and §10.1's gates — which
are all of the form "only the target's author may…" — have nothing to compare.
Make it bus-assigned instead of author-asserted and the protocol acquires an
identity system, a credential store, and a rotation story, none of which belong
in a component whose entire job is ordering.

**Constraints.**

- An author MUST supply `author`; it MUST be non-empty and at most 256 bytes.
- A bus MUST NOT interpret, validate or rewrite it, beyond the domain check. A
  deployment MAY put a proxy in front that stamps or validates it (§12).
- One identity SHOULD be one process. Two processes sharing an `author` are not
  forbidden — the bus cannot tell — but they will contend for their own claims,
  and a reader folding §8.4 will see one author appear to hold and release work
  it never did.
- A reader MUST NOT treat `author` as attested (§2.2).

### 5.3 `payload`

| type | written by | presence | in the hash | trust | limit |
|---|---|---|---|---|---|
| JSON object | author | REQUIRED | yes | untrusted | ≤ 1 MiB serialized |

**Semantics.** The content of the statement. Its shape is entirely the
application's business; the protocol reads exactly one field of one payload
(`verdict`, on a `_.vote`, §8.3).

**Example.** `{ "v": 42, "region": "eu-west-1" }`. An empty object `{}` is valid
and normal — a `_.claim` carries nothing.

**Design rationale.** Constrain `payload` to a schema and the protocol becomes a
data model, which is the thing agents from different vendors will never agree on.
Allow a non-object (a bare string, a number, `null`) and every reader must
type-check before touching it, extensions have nowhere to live, and `{}` — the
overwhelmingly common case — stops being the obvious empty value. v2.0 permitted
any JSON here, and the resulting `null` payloads broke folds that reasonably
assumed a container.

**Constraints.**

- MUST be a JSON **object**. A non-object MUST be rejected with `400`.
- Absent is equivalent to `{}`.
- Serialized size MUST be at most the §B limit; exceeding it MUST be rejected
  with `413`.
- Extensions MUST go in `payload`. A bus MUST ignore and MUST NOT store unknown
  **top-level** fields, and authors MUST NOT rely on them surviving.
- Values a reader can derive — lifecycle state, claim holder, vote tallies,
  supersession status — MUST NOT be written here as though authoritative. A
  reader MUST compute those from §8 and MUST NOT trust a payload field that
  purports to state one. This is an authoring rule and is not machine-checkable.

### 5.4 `refs` — the only relational mechanism

| type | written by | presence | in the hash | trust | limit |
|---|---|---|---|---|---|
| object of strings | author | OPTIONAL | yes, when non-empty | untrusted | ≤ 64 keys |

**Semantics.** Every value names **a fact, or a piece of the world. None names a
party.** This is the structural reason there are no commands (§1.3, step 2).

**Example.**

```jsonc
"refs": { "subject": "deploy:prod", "parent": "b3f1…", "supersedes": "a0c2…" }
```

**Defined keys.**

| key | value | meaning | who may write it | reader gate |
|---|---|---|---|---|
| `parent` | fact id | this fact was caused by that one; causation is transitive `parent` (§8.2) | anyone | none — self-asserted |
| `subject` | **world name** | names the piece of the world this fact is about; the group key of the register (§8.1) | anyone | none |
| `supersedes` | fact id | this fact **replaces** the target | the target's author only | §10.1 |
| `tombstones` | fact id | on a `_.tombstone`: the target is **retracted** | the target's author only | §10.1 |
| `vote` | fact id | with `payload.verdict ∈ {corroborate, contradict}` (§8.3) | anyone but the target's author | §10.1 |
| `claim_of` | fact id | the author asserts responsibility for the target (§8.4) | anyone | ordering (§8.4) |
| `resolves` | fact id | the target is handled; `payload` MAY carry the result | the current claim winner only | §10.1 |
| `release_of` | fact id | the author abandons its own prior claim | the claiming author only | §10.1 |
| `about` | fact id | `context.requested`: the fact found too thin to act on (§8.5) | anyone | none |
| `answers` | fact id | `context.provided`: the request it answers (§8.5) | anyone | none |

**`subject` is a world name, not a fact id.** An opaque non-empty string, at most
256 bytes, chosen by writers who agree on it out of band (`deploy:prod`,
`schema:orders`, `belief:customer-42:churn-risk`). Two agents that have never met
write to the same piece of the world by agreeing on a name — which is precisely
why it cannot be a content address: a content address is only knowable after the
content exists, and they need to agree *before*.

**Lifecycle refs.** `claim_of`, `resolves`, `release_of` and `tombstones` are the
lifecycle refs. **A fact MUST NOT carry more than one**, and a bus MUST reject one
that does.

**Design rationale.** Remove `refs` and there is no way to say a fact is *about*
another fact — no correction, no causation, no claim, no vote — and the log
becomes a pile of unrelated statements. Let a `refs` value name an *agent* and
the "facts, not commands" property dies in one line: `{"to": "worker-3"}` is a
command, and everything about delivery follows it back in (§1.3). Allow more than
one lifecycle ref per fact and §8.4's fold order becomes ambiguous — a fact that
both claims and resolves the same target has no defined effect, and two readers
may legitimately branch differently. Allow empty or null values and the content
address depends on a normalization rule: v2.0 dropped them silently while
hashing, and no second implementation could have known to do the same.

**Constraints.**

- If present, MUST be a JSON object; absent is equivalent to `{}`.
- Every value MUST be a non-empty string. `null` and `""` MUST be **rejected**,
  not dropped.
- At most 64 keys (§B); `refs.subject` at most 256 bytes.
- At most one lifecycle ref per fact; a bus MUST reject a violation with `400`.
- A bus MUST accept unknown keys (forward compatibility) and MUST NOT interpret
  them. The trusted core reads `refs.parent` only, and only to enforce §10.2.
- Readers MUST ignore keys they do not understand.
- Authors SHOULD name a piece of the world and SHOULD NOT name a recipient.

### 5.5 `nonce`

| type | written by | presence | in the hash | trust | limit |
|---|---|---|---|---|---|
| string | author | OPTIONAL | yes, when present | untrusted | ≤ 128 bytes |

**Semantics.** A uniqueness token whose only purpose is to change the author
domain, and therefore the `id`, when the rest of the content would be identical.

**Example.** `"k7x9"` on a re-claim of the same target after an earlier claim
lapsed.

**Design rationale.** Remove `nonce` and idempotence becomes a trap. Append is
idempotent by `id` (§9.4), which is what makes a retry through a network failure
safe — but it means a *legitimate repeat* silently collapses into the original:
re-claiming F after releasing it, or voting the same way twice after new
evidence, produces byte-identical content and therefore the same fact, so the new
action never happens and the author is told it succeeded. `nonce` is the author's
only means of saying "this is a new action, not a retry". Make the bus generate
it instead and the property inverts: every resubmit becomes a new fact and the
retry-safety of §9.4 is gone.

**Constraints.**

- If present, MUST be a non-empty string of at most 128 bytes. `""` MUST be
  rejected.
- Facts carrying a lifecycle ref or `vote` SHOULD always carry a `nonce`.
- A fact intended to be idempotent across restarts — a registration, a scheduled
  beat — SHOULD carry a **stable** nonce derived from its occasion, so that a
  restart reproduces the same `id` and deduplicates.

### 5.6 / 5.7 `ts` and `recv` — specified as a pair

| | `ts` | `recv` |
|---|---|---|
| type | number (unix seconds, fractional allowed) | number (unix seconds, fractional allowed) |
| written by | **author** | **bus** |
| presence | REQUIRED | assigned at append |
| in the hash | **yes** | **no** |
| trust | **advisory** | **trusted** |

**Semantics.** `ts` is when the author *claims* the event happened. `recv` is
when the bus *witnessed* the fact arrive.

**Example.** A machine whose clock is four hours slow reports a build failure:

```jsonc
{
  "type": "build.failed",
  "ts":   1748285600,     // the author says 14:13 — its clock is wrong
  "recv": 1748300000.4,   // the bus witnessed 18:13 — this is the real one
  "payload": { "job": "nightly", "exit": 1 }
}
```

**Design rationale.** Two timestamps look redundant. Remove either and the
protocol breaks:

- **Keep only `ts`.** Every time-based decision now rests on a forgeable number.
  An author — malicious, or merely with a drifting clock — sets `ts` far in the
  past and its own claim expires immediately, letting it bypass exclusivity; sets
  it in the future and it holds a piece of work forever. **§9.1 fails**, and
  §9.1 is the protocol's central result.
- **Keep only `recv`.** `recv` cannot enter the content hash (that would be
  circular, §4.2), so identical content resubmitted always yields the same `id`,
  and an author has **no way to express "this is a new action"** — §9.4's escape
  hatch is gone. Worse, the time the author actually knows (a log line's
  timestamp, a file mtime) has nowhere to live, so provenance loses its only
  author-side clock.

The division of labour is rigid: **`ts` belongs to the content, `recv` belongs to
the witness.**

**Constraints.**

- An author MUST supply `ts`. It MUST be a finite IEEE-754 double; `NaN` and
  ±`Infinity` MUST be rejected with `400`, because a non-finite number is not
  representable in the canonical form (§5.9) and such a fact could never have its
  own `id` recomputed.
- A bus MUST NOT reject an append because `ts` is implausible. The bus does not
  judge content (§2.2).
- A bus MUST assign `recv` and MUST include it in `sig` (§5.10).
- `recv` MUST be non-decreasing in `seq`.
- **Every time-conditioned fold — claim expiry (§8.4) and any TTL — MUST use
  `recv` and MUST NOT use `ts`.** Violating this breaks §9.1 and §9.2.
- A reader MAY display `ts` to a human but SHOULD label it as author-stated.

### 5.8 `seq`

| type | written by | presence | in the hash | trust |
|---|---|---|---|---|
| integer ≥ 1 | bus | assigned | no | trusted |

**Semantics.** The fact's position in the single total order. The only thing the
bus decides.

**Example.** `1337`. The first fact in a log has `seq` 1, so a reader starting at
`since = 0` sees everything.

**Design rationale.** Remove `seq` and there is no total order; folds become
functions of a *set*, two readers legitimately disagree, and §9.1 and §9.2 both
fail — this is the field the entire design exists to provide. Let authors assign
it and it is neither unique nor monotonic and cannot be trusted for precedence.
Derive it from a timestamp and ties are possible, so exclusivity needs a
tie-break rule that is no longer arithmetic.

**Constraints.**

- A bus MUST assign `seq` as a dense, strictly increasing integer sequence
  starting at 1.
- A bus MUST NOT reuse a `seq`, **ever** — including after a truncation or a
  repair (§11.1).
- On recovery, the counter MUST be restored as the maximum `seq` present.

### 5.9 `id` — the content address

| type | written by | presence | in the hash | trust |
|---|---|---|---|---|
| lowercase hex sha256 | either | REQUIRED on a stored fact | — (it is the hash) | **recomputable** |

**Semantics.** The fact's name, computed from its content, so that the name
cannot drift from what it names and any two parties agree on whether they hold
the same fact.

**The computation.**

```
id = sha256( JCS( record ) )                    rendered lowercase hex

record = { "type": …, "author": …, "ts": …, "payload": … }
       + "refs":  present only when refs is non-empty
       + "nonce": present only when nonce is present
```

where `JCS` is **[RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)**.
`seq`, `recv`, `sig` and `id` itself are excluded — they are the bus domain
(§4.2). There is **no normalization step**: §5.1–§5.5 have already rejected
everything that would need normalizing, so the record is exactly the submitted
fields.

**Example.** The record
`{"author":"u","payload":{},"ts":100,"type":"t"}` — note the keys in JCS order
and no whitespace — hashes to the `whole-number-ts` vector's `id` (§A).

**Design rationale.** Use a bus-assigned name instead and two agents cannot
compare facts they obtained separately, deduplication requires a round trip, and
`parent` links name a position rather than a content — so an ancestor could be
swapped without any link changing, and §8.2's tamper-evidence disappears.

Specify canonicalization in prose instead of adopting JCS and you get v2.0: it
described a Python-compatible float rule that the reference implementation
applied to exactly one key, left every other number to whatever the host
language's formatter produced, and never specified key ordering or string
escaping at all. Independent implementations diverged on small exponents, large
exponents, and non-BMP key names. RFC 8785 already specifies all of it — number
serialization (ECMAScript `Number::toString`, shortest round-trip), property
ordering (by **UTF-16 code unit**), string escaping, and whitespace (none) — and
has tested libraries in every language a second implementation would be written
in. Adopting it deletes the problem rather than restating it.

Three consequences an implementer must notice:

- **All v2.0 ids change.** JCS emits no whitespace and does not render `ts: 100`
  as `100.0`.
- **Key order is UTF-16 code unit order.** A Python implementation MUST NOT use
  bare `sorted()`, which orders by code point and gives a different answer for
  non-BMP keys — U+1F600 is one code point above U+FF3A but its UTF-16 high
  surrogate is below it. §A pins this case.
- **Non-finite numbers are not representable**; §5.6 already rejects them.

**Constraints.**

- An author MAY supply `id`. If supplied, the bus MUST recompute it and MUST
  reject a mismatch with `400`.
- A stored fact MUST carry `id`.
- A bus MUST re-verify `id == sha256(JCS(record))` while recovering, and MUST
  report the count of failures (§7.5, §11.1).
- A fact whose `payload` was dropped by compaction no longer hashes to its own
  `id`; it MUST be marked, and a reader MUST NOT report it as an integrity
  failure (§11.2).

### 5.10 `sig`

| type | written by | presence | in the hash | trust |
|---|---|---|---|---|
| hex hmac-sha256 | bus | assigned | no | trusted |

**Semantics.** The bus's attestation that it — and not someone editing the file —
assigned this fact's position and arrival time.

```
sig = hmac_sha256( secret, "id|author|type|ts|recv|seq" )
```

with `ts` and `recv` rendered per JCS number formatting and `seq` as a decimal
integer.

**Design rationale.** Remove `sig` and the bus domain becomes as forgeable as the
author domain the moment anyone can write to the journal file: `seq` and `recv`
are exactly the two fields §9.1 and §9.2 depend on, so an editable log means an
editable winner. Extend it to cover `payload` instead and it would duplicate what
`id` already does — while creating the illusion that an HTTP client could verify
content, which it cannot, because the key is symmetric.

**Two limits an operator must understand.**

- **`sig` covers the header, not the content.** `payload` and `refs` are not in
  the signed message; they are covered by `id`, which recovery re-verifies
  (§11.1). A failing `sig` means the header was altered or the log was written
  under a different secret. It does **not** mean the payload is intact.
- **The delimiter is ambiguous.** `author: "a|b", type: "c"` and
  `author: "a", type: "b|c"` produce the same signing input. Since the HMAC is
  bus-only this is not an authentication bypass, but implementations SHOULD
  length-prefix the fields; a future revision will.

**Constraints.**

- A bus MUST assign `sig` and MUST verify it on recovery when the secret is
  stable, reporting failures via §7.5.
- A verifier MUST compare in constant time.
- The key is symmetric, so **only a holder of the secret can verify**: the bus,
  or a replica sharing the secret. An unauthenticated reader cannot verify `sig`;
  for it, `id` is the integrity check and `seq`/`recv` are trusted by trusting
  the bus.
- Operators MUST configure a stable secret. A bus that generates an ephemeral
  secret at boot MUST report that it has done so (§7.5), because every signature
  written before a restart becomes unverifiable.

---

## 6. A complete example: one contested piece of work

This is one round from beginning to end, with real content addresses. Every `id`
below is reproducible: hash the JCS form of the author-domain fields (§5.9) and
you get the same string. Every fold result below is reproducible too, from the
stream alone.

The scenario: CI reports a failed build. Two agents both try to take it. One
wins, does the work, and reports. Nobody is told anything.

### 6.1 The stream

| # | seq | recv | author | fact | `id` |
|---|---|---|---|---|---|
| 1 | 41 | 1748300000.4 | `ci-bot` | `build.failed` · payload `{job, exit}` | `7f2a743a3f35…` |
| 2 | 42 | 1748300012.1 | `agent-a` | `_.claim` · `claim_of: 7f2a…` · nonce `a1` | `4d5da059c140…` |
| 3 | 43 | 1748300012.9 | `agent-b` | `_.claim` · `claim_of: 7f2a…` · nonce `b1` | `c605e94b9a55…` |
| — | — | — | `agent-b` | *reads back and folds; discovers it lost* | *no fact* |
| — | — | — | `agent-a` | *resubmits #42 byte-for-byte* | *deduped* |
| 4 | 44 | 1748300210.0 | `agent-a` | `_.claim` · `claim_of: 7f2a…` · nonce `a2` | `919131dd57b3…` |
| 5 | 45 | 1748300455.7 | `agent-a` | `fix.done` · `parent: 7f2a…` · `resolves: 7f2a…` · nonce `a3` | `a0266a551b88…` |

Full addresses:

```
41  build.failed  7f2a743a3f3598755651b4c01d6d1fb2b3be5d09b0036545e87d6cfd2b17c45d
42  _.claim       4d5da059c140d54293a5952ffe9654cc03f5e4cc8103d2a2f4334ce06e47fdf9
43  _.claim       c605e94b9a550b05d83105bd4281183869ad501e2a21583cd801b8e5da47e1fd
44  _.claim       919131dd57b3df60aece064d814ae717fa61bc2d69e6143a5be767044463ef57
45  fix.done      a0266a551b884a3a8542e28b94d717bc61b05bdb4130ea06e718579aa2b92aad
```

Fact #41 as it is hashed — JCS order, no whitespace, `recv`/`seq`/`sig`/`id`
absent because they are the bus domain (§4.2):

```
{"author":"ci-bot","payload":{"exit":1,"job":"nightly"},"ts":1748300000,"type":"build.failed"}
```

### 6.2 What each step demonstrates

**1 · `ci-bot` appends `build.failed` (seq 41).** The author wrote `type`,
`author`, `ts`, `payload`; the bus added `seq: 41`, `recv: 1748300000.4`, `sig`.
The `id` is a function of the first group only, which is why it could be computed
before the append and verified after it (§4.2, §5.9).

Note what is *not* here: no assignee, no queue, no "needs fixing". It is a
statement about the world.

**2 · `agent-a` claims it (seq 42).** Intent is expressed the only way anything
is expressed — by appending a fact. A claim is not a lock request and the bus
does not adjudicate it; the bus assigns it a position and stores it, exactly as
it would any other fact.

**3 · `agent-b` claims it too (seq 43).** No error, no rejection, no
serialization. Both claims exist. **42 < 43**, and that is already the whole
answer.

**4 · `agent-b` reads back and folds.** It computes `ownership(#41)` over the
prefix it holds and gets `claimed(agent-a)`. Nobody told it. It was not sent a
rejection, it did not poll a lock service, and it did not need to trust
`agent-a`: it derived the same answer `agent-a` derived, from the same ordered
bytes (§9.1). It moves on to other work.

**5 · `agent-a` resubmits #42 byte-for-byte** — a retry after a socket error, say.
Identical author domain ⇒ identical `id` ⇒ the bus returns the existing
`{seq: 42, recv, sig}` with `deduped: true` and HTTP `200`. **No second claim
exists**, so nothing about the fold changes. This is why a client may retry an
append through a network failure without reasoning about it (§9.4).

**6 · `agent-a` renews with a fresh nonce (seq 44).** The work is taking longer
than Δ. `agent-a` appends the same claim with `nonce: "a2"`, which changes the
author domain and therefore the `id`, so this *is* a new fact. The earlier claim
at seq 42 will lapse at `recv + Δ`; this one, from the same author, is then the
lowest live claim. **Ownership continues with no lock, no lease renewal
endpoint, and no protocol extension** — the overlap is the whole mechanism.

**7 · `agent-a` reports (seq 45).** One fact carries both `parent: #41` — this
work was caused by that failure (§8.2) — and `resolves: #41` — that work is now
handled (§8.4). It carries exactly one lifecycle ref, as §5.4 requires; `parent`
is not one.

The resolve is honoured because `agent-a` is the current claim winner at that
point in the fold. Had `agent-b` appended it, or had nobody claimed #41 at all,
the fold would ignore it (§8.4).

**8 · Any reader, at any later time, folds the same conclusion.**

```
lifecycle(#41) after seq 42       →  claimed(agent-a)
lifecycle(#41) after seq 43       →  claimed(agent-a)      # b's claim is on the log, and loses
lifecycle(#41) after seq 45       →  resolved(agent-a)     # terminal
lifecycle(#41) a day later        →  resolved(agent-a)     # still terminal
chain(#45)                        →  7f2a743a3f35 → a0266a551b88
```

### 6.3 The failure branch

Now suppose `agent-a` dies immediately after seq 44 and never reports.

Its claim at seq 44 has `recv = 1748300210.0`. With Δ = 600 it lapses once a
later fact's `recv` passes `1748300810.0`. `agent-b`, still watching, appends a
fresh claim at `recv = 1748300811.0`:

```
lifecycle(#41)  →  claimed(agent-b)
```

Nothing detected the crash. No supervisor reassigned the work. The expiry is
arithmetic over two bus-stamped numbers, so every reader — including `agent-b`
itself — computes the same handover at the same point (§9.1).

And the property that makes this safe rather than merely convenient: if
`agent-a` had *finished* first, the same late claim from `agent-b` changes
nothing.

```
… seq 45 resolve by agent-a, then a late claim by agent-b at recv + Δ + 1
lifecycle(#41)  →  resolved(agent-a)
```

`resolved` is terminal and is reached before the later claim is folded, so
crash-recovery re-dispatch can never un-do a real completion (§9.3).

---

## 7. Operations

### 7.1 The operation catalogue

There are two operations. Everything else in this section is a convenience over
the second one, or an endpoint outside the protocol.

| operation | direction | effect | idempotent |
|---|---|---|---|
| **append** | author → bus | assign `seq`/`recv`/`sig`, persist, return the receipt | yes, by `id` (§9.4) |
| **read** | reader ← bus | return a window of the ordered stream from a cursor | yes (pure) |

There is deliberately no `claim`, `resolve`, `vote` or `delete` operation. Each
of those is an append of a fact with the appropriate `refs` key, and its meaning
is a fold (§8). A bus that offers a `claim` endpoint has moved meaning into the
trusted core and is not implementing this protocol.

### 7.2 The append sequence

```
POST /facts
{ "type": …, "author": …, "ts": …, "payload": …, "refs": …, "nonce": …, "id"?: … }
```

1. **Validate the author domain** against §5.1–§5.6. On failure the bus responds
   `400` (or `413` for a §B limit) and MUST NOT store anything.
2. **Compute `id`** = `sha256(JCS(record))` (§5.9). If the client supplied an
   `id` and it differs, respond `400`.
3. **Check the dedup index.** If `id` is already present, respond `200` with the
   existing `{seq, recv, id, sig}` and `deduped: true`. Do not write a second
   copy, do not consume a `seq`.
4. **Check causation depth** (§10.2). On excess, respond `400`.
5. **Assign** `seq` (next integer) and `recv` (now, never earlier than the
   previous fact's `recv`), and compute `sig`.
6. **Persist** according to the durability policy (§11.1), then update the
   in-memory projections.
7. **Respond `201`** with `{seq, recv, id, sig, deduped: false}`.

Steps 5–6 MUST be atomic with respect to other appends: a `seq` is issued to
exactly one content, ever (§5.8).

**What the bus does not do.** It does not check that `refs` targets exist — a
`parent` or `claim_of` may name a fact that has not arrived, which is what lets a
client append a chain leaf-first (§10.2). It does not evaluate any fold, so it
never rejects a claim for being late, a resolve for coming from the wrong author,
or a supersede for being unauthorized. Those are reader concerns, and a bus that
decided them would be holding state (§2.1).

**Status codes.**

| code | meaning |
|---|---|
| `201` | appended |
| `200` | already present; identical content, existing receipt returned |
| `400` | malformed: a §5 domain violation, an `id` mismatch, more than one lifecycle ref, or excess causation depth |
| `413` | a §B limit exceeded |
| `429` | admission-rate rejection, if the deployment applies one (§10.3) |

### 7.3 The read sequence

```
GET /facts?since=<seq>&limit=<n>&type=<glob>&author=<s>&refs.<key>=<id>
```

Returns facts with `seq > since`, in ascending `seq`, at most `limit` of them.
The response carries `X-Max-Seq`, the highest `seq` in the window, which the
reader stores as its next `since`. A reader loops until a response is shorter
than `limit`.

All filters are **conveniences, not semantics**. A filtered window is not a
complete prefix, so a fold over it is not normative (§8.0). A bus MAY ignore
every filter and return the unfiltered window; a conforming reader must still
work. Filters exist to save bytes, and a reader that needs a normative answer
must hold the prefix.

**The `type` glob dialect.** `*` matches any run of characters, `?` matches
exactly one. Nothing else is special. The pattern is matched against the whole
`type`. A bus MUST bound the pattern length (§B) and MUST reject an over-long one
with `400`: the pattern is attacker-supplied.

**Cursor conveniences.**

| endpoint | returns |
|---|---|
| `GET /facts/head` | `{ head_seq }` — start a reader at "newest only" |
| `GET /facts/:id` | one fact by content address, or `404` |

### 7.4 A complete claim interaction

This is the full round-trip an implementer has to get right, and it is the one
place where "read back and fold" is not optional.

```
agent                                   bus
  │                                      │
  │  1. GET /facts?since=<cursor>        │   catch up to a complete prefix
  │ ───────────────────────────────────► │
  │ ◄─────────────────────────────────── │   facts, X-Max-Seq
  │                                      │
  │  2. fold: is F open?                 │   ownership(F) == open  (§8.4)
  │     (local; the bus is not asked)    │
  │                                      │
  │  3. POST /facts  _.claim             │   refs.claim_of = F, fresh nonce
  │ ───────────────────────────────────► │
  │ ◄─────────────────────────────────── │   201 { seq: N }   ← NOT a grant
  │                                      │
  │  4. GET /facts?since=<cursor>        │   MUST re-read past N
  │ ───────────────────────────────────► │
  │ ◄─────────────────────────────────── │
  │                                      │
  │  5. fold: claimWinner(F) == me?      │   this is the decision
  │                                      │
  │     yes → do the work                │
  │     no  → move on; you lost, and no  │
  │           message will tell you      │
  │                                      │
  │  6. POST /facts  fix.done            │   refs.resolves = F (+ parent)
  │ ───────────────────────────────────► │
  │ ◄─────────────────────────────────── │   201
```

Four rules this sequence encodes:

1. **A `201` on the claim is not a grant.** It means "your fact is on the log at
   seq N". Whether you won is decided by step 5 and by nothing else. An
   implementation that treats the append receipt as acquisition has a race.
2. **Step 4 must re-read past your own claim.** A competitor's claim may have
   been assigned a lower `seq` than yours while your request was in flight.
3. **Step 5 folds over every fact referencing F** — `claim_of`, `release_of`,
   `resolves` and any `_.tombstone` — not over the claims alone. A single-key
   filter such as `?refs.claim_of=<id>` is **not sufficient**, and a bus SHOULD
   NOT be described as making it cheap: the window hides releases, resolves and
   tombstones, so it errs in both directions — reporting a winner whose claim was
   already released, and reporting work as claimable that is already resolved or
   dead. The filter is useful for *finding* claims on F; deciding the winner is
   the fold, over a complete prefix.
4. **A long-running holder renews rather than releases** (step 6 of §6.2):
   re-claim with a fresh nonce every ~Δ/3. Never release-then-reclaim, which
   opens a window in which the work is genuinely `open`.

### 7.5 Endpoints outside the protocol

A bus MAY expose operational endpoints. They are not part of the wire contract
and a conforming reader MUST NOT depend on them.

| endpoint | purpose |
|---|---|
| `GET /info` | effective configuration and health: protocol version, `head_seq`, fsync policy, whether the secret is stable, `sig` and `id` failure counts, and **Δ** |
| `GET /health` | liveness |
| `POST /admin/rewrite` | trigger compaction (§11.2) |

One hard rule: **an operational endpoint MUST NOT change the result of any §8
fold.** Δ is published here because §8.4 requires every reader to use the log's
value rather than its own (§8.4, §B); that is publication, not mutation.

---

## 8. Fold semantics (normative)

A reader replays facts in `seq` order and folds them into whatever projection it
needs. **This is where conformance lives**: the bus is stateless, so an
implementation that serves §7 perfectly and folds this chapter differently is not
interoperable. Two readers that fold identically always agree, because they
consume the same totally ordered, immutable stream — and that is the entire
point.

### 8.0 The domain of a fold

> Every fold in this chapter is a function of a **complete prefix** of the log:
> all facts with `1 ≤ seq ≤ N`, for some N.

A reader MUST hold a complete prefix to claim a normative result. Folding a
filtered, sampled, or gap-containing window is permitted but yields a
**non-normative approximation**, and an implementation SHOULD NOT present such a
result as one of the folds defined here. What this requirement costs a
reader, and what a deployment may do about it, is §2.3.

Two readers at different N may of course differ — one has seen more of the world.
That is not disagreement; it is latency. Disagreement means two readers at the
**same** N returning different answers, and this chapter exists to make that
impossible (§9.2).

**Termination.** A fold that walks `refs` links MUST terminate on any input,
including a stream a well-behaved bus would never produce. Implementations MUST
bound each walk with a visited set or an explicit depth cap. Do not rely on
§10.2's argument that cycles are unconstructible: it holds for facts appended
through a conforming bus, and folds also run over exported, replicated and
hand-repaired logs.

The four questions of §1.3, in the order an isolated agent actually needs them.

### 8.1 What is X right now — the subject register

A `refs.subject` names a piece of the world. Every fact carrying that subject is
a statement about it; together they are the subject's **register**. This is how a
value that keeps changing is shared between isolated agents without anyone
holding it: nobody stores "the current value", every reader folds it.

```
retracted(x) = ∃ t ∈ prefix : t.type == "_.tombstone"
                              and t.refs.tombstones == x.id
                              and t.author == x.author            # §10.1

history(S) = [ f ∈ prefix : f.refs.subject == S
                            and f.type is not in a reserved namespace (§5.1) ],
             ascending seq

current(S):
  if history(S) is empty              → null
  h ← the highest-seq fact in history(S)
  return retracted(h) ? null : h                                  # nothing is known

supersededBy(F):                        # the fact that IMMEDIATELY replaced F
  if F ∉ prefix or retracted(F)       → null
  E ← [ x ∈ prefix : x.refs.supersedes == F.id                    # explicit successors,
                     and x.author == F.author                     #   authorized (§10.1)
                     and not retracted(x) ]
  G ← [ x ∈ history(F.refs.subject) : x.seq > F.seq               # next in the register
                     and not retracted(x) ]
  C ← E ∪ G
  return C is empty ? null : the LOWEST-seq member of C

isSuperseded(F) = supersededBy(F) != null
```

**Invariants.** For any complete prefix P and subject S:

| # | invariant |
|---|---|
| I1 | `current(S) ∈ history(S) ∪ {null}` — the register's value is always a member of the register. |
| I2 | `history(S)` is strictly increasing in `seq` and grows only by appending; a longer prefix never removes a member. |
| I3 | `supersededBy(F) = G` ⟹ `G.seq > F.seq`. Supersession only ever points forward. |
| I4 | `retracted(F)` ⟹ `¬isSuperseded(F)`. Retracted and superseded are disjoint. |
| I5 | `current(S) ≠ null` ⟹ `¬retracted(current(S))` and `¬isSuperseded(current(S))` within P. |
| I6 | For distinct F, F′ in `history(S)` with `F.seq < F′.seq` and neither retracted: `isSuperseded(F)`. Every non-head live member is superseded by the next one. |

**Six rules make this deterministic where v2.0 was not.**

1. **`current(S)` ranges over `history(S)` only.** A fact that wants to become
   the current value of S MUST carry `refs.subject: S`. In v2.0 an explicit
   successor could become `current(S)` without carrying the subject, so
   `current(S) ∉ history(S)` was reachable and I1 failed. To say what X is now,
   say it *about X*.
2. **`supersededBy` returns the immediate successor** — the lowest-seq candidate,
   not the newest. "What replaced F" is the next statement; the latest statement
   is `current(S)`. Following `supersededBy` repeatedly walks the register
   forward one step at a time.
3. **Ties break by `seq`,** which is total, so there is never a choice. If two
   authorized successors exist, the lower `seq` is the successor and the other is
   an ordinary fact that also claims to replace F. A reader that cares about such
   forks can enumerate `E` itself.
4. **Only an author may supersede their own fact** (§10.1). Replacement says *"my
   earlier statement is out of date"*; a third party observing staleness
   contradicts (§8.3) or writes to the register, and does not get to retire
   someone else's statement. This costs the register nothing — progression there
   happens by group order, not by explicit `supersedes`.

   **What the gate is worth, precisely.** It protects a fact that is *not* a
   register member. For such a fact, `supersedes` is the only route to
   `superseded`, so gating it stops any author from silencing another author's
   trust state — §8.3 ranks `superseded` above every vote — with a single
   append.

   It does **not** protect a fact carrying a `subject`, and cannot. A register
   is a piece of shared world state that anyone may write to; that is what makes
   it shared (§5.4). The next member supersedes the previous one by group order,
   with no author gate anywhere in that path. So a stranger still moves a
   register head, and the displaced fact still folds to `superseded` — by the
   very route this rule names one sentence above as the sanctioned alternative.

   The consequence for readers is the part worth stating plainly: **inside a
   register, `superseded` is a statement about the register, not about the
   fact.** It means only *something later was said about X*, which any writer
   may cause. A reader weighing whether to believe a fact's content MUST read
   §8.3's vote states and MUST NOT treat `superseded` as evidence that the
   content was wrong.
5. **A retracted successor supersedes nothing.** If the fact that replaced F is
   itself later tombstoned, `supersededBy(F)` falls back to the next candidate
   and then to `null`. Otherwise retracting a bad replacement would leave the
   original permanently `superseded` — with nothing current in its place.
6. **Reserved-namespace facts are not register members.** Tagging a
   `_.tombstone` with `refs.subject` is a natural mistake, and without this rule
   the retraction itself becomes `current(S)` and simultaneously supersedes the
   fact it retracts — violating both I1 and I4. A tombstone retracts through
   `refs.tombstones` alone.

**Retraction is not rollback.** A tombstoned register head folds to `null` —
*nothing is currently known* — and not to the previous value. Resurrecting an
older statement would assert something no author currently asserts. A tombstone
on a non-head member does not change `current(S)`; it marks that member retracted
for §8.3 and §11.2.

**Latest-wins is one reader policy, not the only one.** A reader accumulating
multi-source observations reads `history(S)` and does not collapse it. This is a
supported and expected use of a register; §11.2 protects it by forbidding
compaction from destroying non-head payloads.

### 8.2 How did this come to be, and what did it lead to — the trail

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
because it has not arrived yet, or was filtered out, or never existed. When a
walk reaches such a reference, an implementation MUST surface it as an explicit
**gap marker** carrying the unresolved id, and MUST NOT silently stop as though a
root had been reached. A truncated chain that looks complete is worse than no
chain: it turns "I could not see the origin" into "this is the origin".

**Invariants.**

| # | invariant |
|---|---|
| I7 | `chain(F)` is finite and contains no repeated `id` — guaranteed by the visited set of §8.0, not by the bus. |
| I8 | `G ∈ descendants(F)` ⟺ `F ∈ chain(G)`, whenever both are fully resolvable in P. |
| I9 | Both are monotone in the prefix: a longer prefix can add members and can replace a gap marker with a fact, but never removes a member. |

**What the trail actually proves.** Because `id` is a content address, a `parent`
link names *that exact content* and cannot be re-pointed after the fact; because
facts are immutable and removal is explicit (§10.1), an ancestor cannot be
silently rewritten.

> The trail therefore proves that **the named ancestor existed and has not been
> altered**. It does **not** prove that the child was actually caused by it —
> anyone may write `parent` pointing at anything. Provenance here is
> tamper-evident, not attested.

v2.0 claimed this was "provenance that holds across organizational boundaries
without anyone vouching for it". That is too strong: the *link* holds without
vouching; the *claim of descent* is the child author's assertion, and is worth
exactly what that author is worth (§8.3, §10.1).

### 8.3 Should I believe it — trust

Fold `_.vote` facts referencing `F`. A reader MUST ignore self-votes
(`vote.author == F.author`) and MUST count only each author's **latest** vote by
`seq`, so a voter who changes their mind is never double-counted.

```
trust(F, quorum):                        # quorum is the READER's policy; MUST be ≥ 1, default 2
  if F ∉ prefix                → the reader MUST NOT return a result
  if retracted(F) (§10.1)      → retracted     # the author took it back
  if isSuperseded(F) (§8.1)    → superseded    # freshness beats confidence
  V ← for each author a ≠ F.author, that author's highest-seq _.vote on F
      whose payload.verdict ∈ {corroborate, contradict}
      and which its own author has not retracted
  C ← |{ v ∈ V : verdict == corroborate }|
  X ← |{ v ∈ V : verdict == contradict }|
  if X ≥ quorum   → refuted
  if X > 0        → contested
  if C ≥ quorum   → consensus
  if C > 0        → corroborated
  else            → asserted
```

**State precedence.** `retracted` > `superseded` > `refuted` > `contested` >
`consensus` > `corroborated` > `asserted`. The first two are properties of the
fact; the rest are tallies.

**Three v2.0 defects are closed here.** `retracted` is a distinct state:
§10.1 requires trust to distinguish retraction from replacement, and v2.0 had no
state for it, so a tombstoned fact could fold to `consensus`. `quorum` MUST be
≥ 1, because `quorum = 0` made every unvoted fact `refuted`. And a vote whose
`verdict` is missing or unrecognized is **excluded from `V` entirely** rather than
occupying its author's slot — in v2.0 a later junk vote silently cancelled that
author's earlier valid one.

To evaluate self-votes a reader needs `F` itself. If `F` is not in the prefix the
reader MUST NOT return a `trust` result; this is §8.0 restated, and it is why a
filtered window is not foldable.

**A quorum counts distinct `author` strings, so trust is worth exactly what
`author` is worth.** `author` is self-asserted and this protocol does not
authenticate it (§10.1). On a deployment that does not authenticate writers, one
writer manufactures any trust state at any quorum in either direction, and the
self-vote MUST above buys nothing — it is defeated by a second string. This is
the only fold whose result depends on authors being *distinct principals* (§8.4's
ordering results do not), and a reader on an unauthenticated bus MUST treat every
state above `asserted` as unverified.

**Trust has no global value, so never coordinate on it.** Because `quorum` is the
reader's choice, two readers can legitimately disagree about whether F is
`refuted` or `consensus`, and the bus does not adjudicate. Any decision all
participants must agree on MUST be built on §8.4, which every reader computes
identically. Trust is for advice and triage, never for arbitration. Trust also
does not propagate: a reader that cares about a chain's validity walks §8.2 and
checks ancestors itself.

### 8.4 Who is responsible for it — ownership

This fold is a **corollary** of the three above: responsibility for a fact is one
more piece of world state, and because the world is totally ordered, the answer is
unambiguous. It is listed last because it is derived, not because it is optional —
it is fully normative, and it is where the log's most useful accident lives.

**Δ is a property of the log, not of the reader.** A bus MUST publish Δ (§7.5)
and every reader MUST fold with the published value. A reader that substitutes
its own is **non-conforming**, and §9.1 does not hold for it. In v2.0 Δ was a
per-reader knob with a documented default, and two readers folding one stream
with different Δ disagreed not only about who held a claim but about whether the
work was `resolved` at all.

```
ownership(F):                            # facts referencing F, ascending seq
  active ← []                            # live claims: {author, seq, recv}
  for fact in [ x ∈ prefix : x has a lifecycle ref naming F ], ascending seq:

    if fact is a _.tombstone on F, authored by F.author  → return dead        # terminal §10.1

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

claimWinner(F) = owner of ownership(F) when claimed or resolved, else null
```

A fact carries at most one lifecycle ref (§5.4), so the branches are mutually
exclusive by construction and the `elif` chain is exact.

**State transitions.** The states are `open`, `claimed(a)`, `resolved(a)`,
`dead`. Reading a fact `x` with the fold above:

| from | fact | condition | to |
|---|---|---|---|
| `open` | `claim_of: F` | — | `claimed(x.author)` |
| `open` | `resolves: F` | — | `open` (ignored — no winner to honour) |
| `open` | `release_of: F` | — | `open` (ignored — no claim held) |
| `claimed(a)` | `claim_of: F` | `x.recv > claim(a).recv + Δ` | `claimed(x.author)` |
| `claimed(a)` | `claim_of: F` | otherwise | `claimed(a)` — a stays lowest-seq live |
| `claimed(a)` | `release_of: F`, `x.author == a` | — | `claimed(next live)` or `open` |
| `claimed(a)` | `release_of: F`, `x.author ≠ a` | — | `claimed(a)` (ignored) |
| `claimed(a)` | `resolves: F`, `x.author == a` | — | **`resolved(a)` — terminal** |
| `claimed(a)` | `resolves: F`, `x.author ≠ a` | — | `claimed(a)` (ignored) |
| `claimed(a)` | — | `now > claim(a).recv + Δ`, no later fact | `open` *(advisory)* |
| any | `_.tombstone`, `x.author == F.author` | — | **`dead` — terminal** |
| any | `_.tombstone`, `x.author ≠ F.author` | — | unchanged (ignored) |
| `resolved` / `dead` | anything | — | unchanged — **terminal** |

**Invariants.**

| # | invariant |
|---|---|
| I10 | At most one author is the claim winner at any prefix. |
| I11 | `resolved` and `dead` are absorbing: once reached at prefix P, `ownership` returns the same value for every P′ ⊇ P (§9.3). |
| I12 | The winner is `min seq` over live claims — a total order on a finite set, so it exists and is unique whenever the set is non-empty. |
| I13 | Every state transition is caused by exactly one fact, except the advisory trailing expiry, which is caused by the clock. |

**The exclusivity result.** If several authors append `claim_of: F`, the one with
the **lowest `seq`** wins. Every reader computes the same winner from the same
ordered, `recv`-stamped prefix — see §9.1 for the statement and proof.

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

**To resolve, first claim.** A `resolves: F` is honoured **only** from F's current
claim winner. There is no ungated path.

v2.0 had one: a fact that had never been claimed could be resolved by any author,
as a convenience for "broadcast" facts anyone may close. That convenience is a
denial primitive. `resolved` is terminal, so a single well-formed fact from any
writer closes any never-claimed item permanently, and nothing in the fold can
distinguish it from a real completion. Meanwhile the implementation had widened
the branch further, honouring a stranger's resolve whenever no claim was *live* —
so a lapsed claim, which means the work needs re-dispatch, could be closed by a
passer-by.

Requiring a claim costs one append and states exactly the right thing: *I am
taking responsibility for this.* It also simplifies the fold — there is no "was
it ever claimed" flag to carry, and a `resolved` fact always names the author who
resolved it, where v2.0 returned `resolved(null)` and discarded the resolver's
identity on precisely the branch it blessed.

### 8.5 Optional conventions

These are conventions layered on the same primitive: no new wire mechanics, no
reserved behaviour, no effect on §8.1–§8.4 or on the §A vectors. An
implementation MAY ignore them entirely, and a reader MUST NOT treat their
absence as an error. Their maturity is **Experimental**: they may change or be
removed in a minor revision, and §A.1's conformance targets do not include them.

**Colony registry (`sys.registry`).** An agent MAY announce what it consumes and
emits, so a supervisor can close the loop between the two. `payload.interests` is
an array of §7.3 globs over fact types; `payload.publishes` is an array of types.
Both MUST be arrays of strings if present; a reader MUST ignore malformed
entries. The roster is the latest `sys.registry` per author, **excluding authors
whose latest registration is retracted** — that is how an agent leaves. Ordering
of the roster is the reader's choice and MUST NOT be locale-dependent. At most 64
entries each (§B): every entry is a glob every reader evaluates.

Folding the roster against the stream surfaces three gaps a bare log cannot:
fact types no registered agent is interested in (published into the void),
declared interests that match nothing (an agent waiting on silence), and declared
outputs that never appear (a silent producer). Reserved-namespace types are
excluded from that analysis — nobody declares an interest in a `_.claim`.

**Context sufficiency (`context.requested` / `context.provided`).** A fact may
assert "X is broken" without enough context for the agent that cares to act.
Rather than let that dead-end silently, the interested agent appends
`context.requested` with `refs.about` naming the thin fact and a
`payload.question`; any agent that can answer appends `context.provided` with
`refs.answers` (or `refs.parent`) naming the request. A reader folds out the
requests still waiting for an answer.

---

## 9. Properties and proofs

Four results carry the design. Each is stated with its premises exposed, proved
from §8, and — the part that matters most in practice — bounded, because a
guarantee whose limits are not written down will be relied on outside them.

Throughout, P denotes a complete prefix (§8.0) and P′ ⊇ P a longer one.

### 9.1 Exclusivity

> **Theorem 1.** Let F be a fact and P a complete prefix in which at least one
> live claim on F exists. Then `ownership(F)` over P designates exactly one
> author as the claim winner, and every reader holding P and folding with the
> same Δ designates the *same* author.

**Proof.**

1. By §5.8, `seq` is a strictly increasing integer assigned by a single component
   to exactly one content each. So the facts of P admit exactly one ascending-`seq`
   enumeration — the iteration order §8.4 specifies is canonical, not a choice.
2. By §3.2 facts are immutable, and by §4.2 the fields §8.4 reads —
   `refs`, `author`, `recv`, `seq` — are fixed at append. Two readers holding P
   therefore read identical values for every branch condition.
3. Each step of §8.4's loop is a total function of (current `active` set, the
   fact being read, Δ). By induction over the enumeration in (1), the `active`
   set after k facts is a function of P and Δ alone.
4. On termination, the winner is `min seq` over `active`. `seq` is a total order
   (1) and `active` is finite, so the minimum exists and is unique whenever
   `active` is non-empty.
5. By (3) and (4), the designated author is a function of (P, Δ). Two readers
   with the same P and Δ obtain the same value. ∎

**Premises, and what breaks without each.**

| premise | source | remove it and |
|---|---|---|
| A single total order | §2.4, §5.8 | two claims may be incomparable; `min seq` is not defined; there is no winner to agree on |
| Immutability | §3.2 | the fold is not a function of the log, since the same P yields different results at different times |
| A complete prefix | §8.0 | a reader missing the lower-`seq` claim elects the higher one — **both readers believe they won** |
| One Δ for all readers | §8.4, §B | readers disagree about which claims are live, hence about the winner, and about whether the work is `resolved` at all |
| Expiry keyed on `recv`, not `ts` | §5.6/§5.7 | expiry rests on an author-supplied number: set `ts` far in the past and your own claim expires instantly, bypassing exclusivity; set it in the future and hold the work forever |
| Purity of the fold | §8.0 | two readers may compute different answers from identical input, which is the definition of the failure |

**What the theorem does *not* say.**

- It does not say the winner is *entitled* to the work. It says every reader
  agrees who it is. If `author` is forged (§10.1), the agreed-upon winner may be
  an impostor — and every reader will agree on that impostor. **Exclusivity is
  agreement, not authorization**, and it is the one result in §8 that survives a
  dishonest `author` intact, because it never asks whether a name is truthful,
  only which name came first.
- It does not extend to the trailing branch. See §9.3.
- It is not a mutual-exclusion primitive in the operating-system sense: nothing
  prevents a losing author from doing the work anyway. It guarantees that if
  every participant folds before acting, exactly one concludes it should act.

### 9.2 Determinism

> **Theorem 2.** For every fold in §8.1–§8.4, two readers holding the same
> complete prefix P and the same reader parameters return identical results.

**Proof.** Each fold is defined as a pure function of P and its parameters: no
fold reads the clock (except §8.4's trailing branch, excluded here by parameter),
no fold reads external state, and no fold reads a mutable field, since none
exists (§4.2). P determines a unique ordered sequence by Theorem 1 step (1).
Identical function, identical input, identical output. ∎

**The reader parameters are exactly two**, and both are named so that "same
parameters" is checkable rather than vague:

| parameter | chosen by | consequence of differing |
|---|---|---|
| Δ | **the log** (§8.4) — a reader MUST NOT choose it | readers disagree about ownership; §9.1 void |
| `quorum` | **the reader** (§8.3) — legitimately per-reader | readers legitimately disagree about trust, which is why nothing may be coordinated on it |

**Boundary — different prefixes are not disagreement.** Two readers at prefixes
of different length may return different answers. That is latency, and it is
expected: one has seen more of the world. Disagreement means two readers at the
**same** N returning different answers, and Theorem 2 says that cannot happen.
The practical form of this: a reader that needs a stable answer waits for the
next fact rather than for a timeout, because a fact settles the question for
everyone at once, whereas a timeout settles it for one reader at a time.

### 9.3 Monotonicity

This is the property a shared world actually needs, and it is the one v2.0 never
stated: **if a conclusion can silently reverse, no agent can act on it.**

The honest answer is that some results are stable and some are not, and the
design depends on knowing exactly which.

> **Theorem 3 (absorption).** If `ownership(F)` over P returns `resolved(a)` or
> `dead`, then it returns the same value over every P′ ⊇ P.

**Proof.** Both values are produced by an immediate return inside the loop, on
reading a specific fact x — a `resolves` from the current winner, or a
`_.tombstone` from F's author. In P′ the enumeration is still ascending `seq`
(Theorem 1 step 1) and x still occupies the same `seq`, because a `seq` is never
reused (§5.8). Every fact P′ adds beyond P has a higher `seq` than P's maximum,
hence a higher `seq` than x. The loop therefore reaches x having read exactly the
same preceding facts and returns before reading anything new. ∎

**What is monotone.** These grow but never retract as the prefix grows:

| result | why |
|---|---|
| `resolved(a)`, `dead` | Theorem 3 |
| `history(S)` | membership is a per-fact predicate; adding facts only adds members (I2) |
| `descendants(F)` | same (I9) |
| `chain(F)` | grows only by resolving a gap marker into a fact and continuing upward (I9) |
| "fact F exists" | append-only (§3.2) |

**What is not monotone, by design.**

| result | how it changes | why that is correct |
|---|---|---|
| `current(S)` | moves to a later member; becomes `null` on retraction of the head | it answers "what is X *right now*". A register that could not change would not be a register. |
| `supersededBy(F)` | `null` → an id when a successor arrives; back to `null` or to a later candidate if that successor is itself retracted | §8.1 rule 5: otherwise retracting a bad replacement strands the original |
| `trust(F, q)` | any state to any state | it is an opinion tally, and opinions change. This is why §8.3 forbids coordinating on it. |
| `claimed(a)` | to `claimed(b)` on expiry, to `open` on release | this **is** crash recovery. A claim that could never move would make one crashed agent permanently strand a piece of work. |

**The boundary, stated sharply.** `claimed(a)` is *not* stable, and the trailing
branch of §8.4 makes it worse: with no later fact to prove that time has advanced,
the fold falls back on the reader's own clock, so two readers at the **same
prefix** can differ. This is the one place Theorem 2 does not reach, and it is
why §8.4 marks the branch advisory:

> A reader MUST NOT make a terminal decision on a trailing `claimed` or a
> trailing `open`. It MAY use it to answer "should I try?" — the cost of being
> wrong there is one wasted claim, which the fold then resolves.

The rule that makes this safe in practice: **act on absorbing states, probe on
advisory ones.** Committing to work is gated on becoming the winner (§7.4 step 5)
and completion is recorded as a fact, which is absorbing. So the worst outcome of
a wrong advisory read is a redundant claim, never a lost or duplicated
completion.

### 9.4 Idempotence

> **Theorem 4.** Appending a fact whose author-domain fields are byte-identical
> to an existing fact's leaves the log unchanged and returns the existing
> receipt.

**Proof.** By §5.9, `id` is a function of the author domain alone. Identical
author domains therefore produce an identical `id`. §7.2 step 3 consults the
`id → seq` index before assigning a `seq`; on a hit it returns the stored
`{seq, recv, sig}` and writes nothing. The log is unchanged, and the response
identifies the same fact. ∎

**Why this is the right default.** A client that loses a connection mid-append
does not know whether the fact landed. With Theorem 4 it simply retries, and the
outcome is the same either way — no dedup key to invent, no "at least once"
caveat to reason about, no compensating logic.

**And why it needs an escape hatch.** The same theorem means a *legitimate
repeat* silently collapses: re-claiming F after releasing it, or voting the same
way twice after new evidence, produces identical content and therefore the same
fact — so the intended new action never happens, while the author is told the
append succeeded. `nonce` is the author's means of changing the author domain
deliberately (§5.5), and facts carrying a lifecycle ref or a `vote` SHOULD always
carry one.

This is exactly the model of a content-addressed store such as git: identical
content is one object; to get another object, change the content.

---

## 10. Authorization and enforcement

Two different mechanisms are collected here because implementers routinely
confuse them:

- **Fold gates (§10.1)** are rules *readers* apply. They decide what a fact
  *means*. The bus does not evaluate them and MUST NOT reject an append for
  failing one.
- **Bus rules (§10.2, §10.3)** are checks the *bus* applies at append. They
  decide what may be *stored*. They are about well-formedness and resource
  bounds, never about truth or permission.

Nothing in this protocol restricts *who may append*. Every writer may write
anything the field domains allow.

### 10.1 The gate table

A **fold gate** is a rule a reader MUST apply. An ungated key is *self-asserted*:
it says what its author believes, and readers weigh it.

| ref | gate a reader MUST apply |
|---|---|
| `resolves` | Honour only from the target's current claim winner. There is no ungated path — to resolve, first claim (§8.4). |
| `release_of` | Honour only from an author holding a live claim on the target. |
| `tombstones` | Honour only when `fact.author == target.author`. A tombstone by any other author MUST NOT retract the target; a reader MAY surface it as a *requested* retraction. |
| `vote` | Ignore when `vote.author == target.author` (§8.3). |
| `claim_of` | Not gated by identity — gated by **order**. The lowest live `seq` wins (§8.4). |
| `supersedes` | Honour only when `fact.author == target.author` (§8.1). A third party expresses staleness by contradicting (§8.3) or by writing to the register, not by retiring someone else's statement. |
| `parent`, `subject`, `about`, `answers` | Not gated. Self-asserted. |

**Self-asserted links are claims, not proofs.** A `parent` says the author
believes this was caused by that; a `subject` says the author believes this is a
statement about X. Neither is verified by anything, and a reader that treats them
as attested has misread the trust boundary (§2.2). What content addressing buys
is narrower and still valuable: the *target* of a link cannot be swapped after
the fact (§8.2).

**Deletion is a fact.** The bus never mutates or silently drops a stored fact.
Removal is an appended `_.tombstone` whose `refs.tombstones` names the target,
subject to the gate above.

Tombstoning and superseding are **different** and folds MUST tell them apart:

- **superseded** — a successor replaced this. The register moves on (§8.1); trust
  reports `superseded` (§8.3).
- **retracted** — the author takes this back. The register folds to `null`, not
  to the previous value; trust reports `retracted`; lifecycle is `dead` and
  terminal.

The tombstone gate is new in v3.0 and it closes a real hole. In v2.0 any author
could tombstone any fact, and the effect was unusually destructive: the target's
lifecycle became `dead` — a **terminal** state — its register folded to `null`,
and compaction was then entitled to destroy its payload on disk (§11.2). That is
a protocol-sanctioned data-destruction primitive available to every writer.
Retraction is now what it should be: **taking back your own statement.**

Operator-driven removal (legal takedown, erasure request) is deliberately *not*
modelled as a fact. It is an out-of-band operation on the log, subject to §11.2.

**`author` is self-asserted.** It is a string the writer chose. This protocol does
not authenticate it and has no notion of identity. Authentication is a transport
concern — mTLS, a gateway, an API key header — and a deployment MAY run the bus
on a trusted network or behind a proxy that validates or stamps `author`.

> A bus reachable by an untrusted party has no integrity story for `author`, and
> therefore none for §8.3 or for the *authorization* half of §8.4. A public
> deployment SHOULD authenticate writers and SHOULD NOT expose write access
> unauthenticated.

Nothing in the fold layer can compensate for this, and readers SHOULD NOT pretend
otherwise: every guarantee in §8 is relative to the honesty of `author`, except
the ordering result of §9.1, which holds regardless.

### 10.2 Mandatory rules (the bus MUST)

Deliberately minimal: enough to keep an append-only log from being weaponized
into unbounded growth, unbounded work, or nonsense no reader can fold. Everything
else is a reader concern.

| # | rule | on violation |
|---|---|---|
| M1 | Reject a fact violating any §5 presence, type or domain rule | `400` |
| M2 | Reject a fact carrying more than one lifecycle ref (§5.4) | `400` |
| M3 | Reject a fact exceeding a §B limit | `413` |
| M4 | Recompute `id`; reject a client-supplied mismatch | `400` |
| M5 | Reject a fact whose causation depth exceeds the maximum (§B) | `400` |
| M6 | Assign a dense, strictly increasing `seq`, never reused (§5.8) | — |
| M7 | Assign `recv`, non-decreasing in `seq` (§5.7) | — |
| M8 | Sign `id\|author\|type\|ts\|recv\|seq` (§5.10) | — |
| M9 | Persist before responding `201`, per the durability policy (§11.1) | — |
| M10 | Re-verify `id` and `sig` on recovery and report both counts (§11.1) | — |
| M11 | Refuse to start on interior log corruption (§11.1) | — |
| M12 | Accept unknown `refs` keys and MUST NOT interpret them | — |
| M13 | Ignore and MUST NOT store unknown top-level fields (§5.3) | — |
| M14 | Never mutate or delete a stored fact except by compaction under §11.2 | — |

**M5, precisely.** Depth is computed by walking `refs.parent` through facts
**present in the log at append time**, counting the new fact as depth 1 when its
parent is absent or unnamed. A fact whose depth is exactly the maximum is
accepted; `depth > max` is rejected.

> **This bounds the walk, not the chain.** A `parent` MAY name a fact that is not
> present (§8.2), so an author can construct an arbitrarily deep chain by
> appending it leaf-first and letting the ancestors arrive afterwards. That is
> permitted — append order must not determine validity in a log read by cursor —
> and it means M5 is a cheap bound on *work at append time*, not a guarantee
> about the depth of any trail a reader will later fold. Readers MUST bound their
> own walks (§8.0). v2.0 presented this rule as a safety guarantee; it is a
> rate-limiter.

**Cycles.** A `refs.parent` cycle cannot be constructed through a conforming bus:
closing a loop A→B→A requires A's `id` — and therefore A's frozen content, which
already names B — before A is hashed, i.e. a sha256 pre-image. This argument is
sound for appended facts and unsound for everything else: exported, replicated,
truncated and hand-repaired logs exist. It is why §8.0 requires folds to
terminate regardless, and why the bus's own depth walk MUST be bounded.

### 10.3 Recommended rules (the bus SHOULD / MAY)

These are deployment choices. An implementation that omits every one of them is
still conforming; one that adopts them MUST document and expose its settings
(§7.5), because each changes an operational promise.

| # | rule | note |
|---|---|---|
| R1 | SHOULD authenticate writers on any network reachable by an untrusted party | §10.1, §12 |
| R2 | MAY apply a per-author token bucket and a global admission cap | rejections are facts-not-written, never state mutations. **No default is specified**: a default for an optional mechanism is a promise the protocol does not keep |
| R3 | SHOULD bind to a loopback interface unless deliberately exposed | the bus trusts its callers |
| R4 | MUST report a non-stable secret through `/info` | every `sig` written before a restart becomes unverifiable (§5.10) |
| R5 | SHOULD offer `fsync`-per-append by default; MAY offer a relaxed policy | a relaxed policy changes what `201` means and MUST be reported (§11.1) |
| R6 | SHOULD length-prefix the `sig` message fields | §5.10's delimiter ambiguity; a future revision will require it |
| R7 | MAY clamp an over-large read `limit` rather than rejecting it | §7.3 |

---

## 11. Storage and recovery

### 11.1 The log

The bus is an append-only log — one JSON record per line — written in `seq`
order. `recv` MUST be non-decreasing in `seq`.

**Durability.** A `201` means the fact is persisted according to the configured
policy. `fsync`-per-append is the default (R5). A relaxed policy (per batch, per
second) MAY be offered and MUST be reported through `/info`, because it changes
what a `201` promises.

**Recovery.** Read the log in order.

- On a **torn final record** — a trailing byte range that does not parse — the
  bus MUST **truncate the file to the last byte offset that parses** before
  accepting any append. Skipping the fragment and appending after it is not
  sufficient: the new record is concatenated onto the fragment, the combined line
  does not parse, and an acknowledged fact is silently lost on the next restart
  while its `seq` has been handed to different content. That breaks the total
  order everything in §8 rests on, and it is the single most severe defect this
  version fixes.
- On a **whole trailing record that lost only its newline**, the bus MAY repair
  the file by writing the terminator rather than truncating. Nothing needs to be
  lost to make the file appendable again.
- On a **corrupt record that is not the final one**, the bus MUST NOT start
  normally (M11). It MUST report the offset and require an explicit repair
  action. Silently skipping an interior record renumbers nothing but removes a
  fact other readers have already folded, permanently forking their view.
- The bus MUST re-verify `id == sha256(JCS(record))` while recovering, and MUST
  report the count of failures (§7.5). §5.10's `sig` does not cover content, so
  this is the only check that detects on-disk payload tampering.
- The bus MUST verify `sig` when the secret is stable, and MUST report failures
  separately from `id` failures. They mean different things: a `sig` failure is a
  tampered or foreign-secret **header**; an `id` failure is tampered **content**.
- `seq` is restored as the **maximum** `seq` present. A bus MUST NOT reuse a
  `seq`, ever, including after a truncation or a repair.

There is no in-memory state machine to rebuild: the log *is* the state, and the
derived indexes (the `seq` counter, the `id → seq` map) are pure projections.
That is the reliability dividend of §1.3 step 5.

### 11.2 Compaction

Compaction reclaims space. Its one binding rule:

> **Compaction MUST NOT change the result of any §8 fold.**

Concretely, a compactor:

- MUST retain the full skeleton `{id, seq, recv, author, refs, sig}` of every
  fact. Every fold depends on it: trails need `refs.parent`, the claim winner
  needs `seq` + `author` + `refs.claim_of`, trust needs `author` + `refs.vote`.
- MUST NOT drop the `payload` of a fact whose payload a fold reads. That is at
  minimum every `_.vote` (§8.3 reads `payload.verdict`) and every fact returned
  by `current(S)`.
- MUST NOT treat supersession alone as grounds for dropping a payload. Only
  **retraction** (§10.1) is. A superseded fact is still a member of `history(S)`,
  which §8.1 explicitly supports readers accumulating over — v2.0's compactor
  stripped every non-head member of every register, destroying exactly the use
  case the register section recommends.
- MUST write to a temporary file, fsync it, rename atomically, and fsync the
  containing directory.

**A compacted fact no longer hashes to its own `id`.** This is unavoidable —
dropping a payload changes the content — and it means a stripped fact's content
address is a historical name rather than a live checksum. An implementation MUST
therefore **mark** a fact whose payload was dropped, so a reader can tell
"verified" from "unverifiable" instead of concluding the log was tampered with. A
reader MUST NOT report a compacted fact as an integrity failure.

Given the above, operators should treat compaction as a retention policy applied
to retracted content, not as a general space optimization. A log that must shrink
further should be truncated at a checkpoint and archived, which loses old
prefixes honestly rather than corrupting the folds over them.

### 11.3 Replication and scale

Permitted, within §2.4:

- **Read replicas** receive the log in `seq` order and serve reads. Sound by
  construction: a replica lagging by N facts is a reader at an earlier prefix,
  which §9.2's boundary already covers. A replica MUST NOT accept appends. A
  replica sharing the bus secret can verify `sig`; one that does not, cannot.
- **Sharding by world** — independent logs for independent subject spaces — is
  simply separate worlds. A fold MUST NOT span two logs: `seq` is meaningful only
  within one log, so there is no order to fold over.

Not permitted, and not described here: any arrangement in which two components
assign `seq` for the same log. That is a different protocol.

---

## 12. Security considerations

### 12.1 The threat model in one table

| adversary | can | cannot | mitigation |
|---|---|---|---|
| **A writer with network access** | append anything the domains allow; claim any fact; write any `author` string; flood the log | alter or delete an existing fact; change a `seq` or `recv`; forge `sig` | R1 (authenticate), R2 (admission rate), R3 (do not expose) |
| **A writer impersonating another `author`** | manufacture any §8.3 trust state; appear to hold or release someone else's claims; retract or supersede the impersonated author's facts | change what any reader computes *given the same log* — every reader agrees on the same forged winner (§9.1) | R1. There is no in-protocol mitigation (§10.1) |
| **A reader** | read everything on the log | write; verify `sig` (the key is symmetric, §5.10) | no confidentiality boundary exists between authors — this is a design fact, not a gap to close |
| **Someone with filesystem access** | rewrite payloads; splice or delete records; replace the whole log | do so undetectably: `id` re-verification catches content edits and `sig` catches header edits (§11.1) | M10, a stable secret, filesystem permissions |
| **A malicious bus** | reorder, drop, fabricate, forge any signature | — | **none.** The bus is trusted (§2.3). A deployment that cannot trust its bus cannot use this protocol |
| **A resource attacker** | submit deep causation chains, huge payloads, expensive globs | exceed the §B limits | M3, M5, §B glob length cap, R2 |

### 12.2 What the protocol deliberately does not protect

- **Confidentiality.** Everything on the log is readable by every reader. Facts
  that must not be shared do not go on a shared log.
- **`author` integrity.** §10.1. Every consequence flows from this one sentence,
  and §8.3 is void without transport-level authentication.
- **Payload truth.** The bus never judges content (§2.2). §8.3 is the designed
  response — contradiction by other authors — and it is advisory (§8.3).
- **Availability under partition.** §2.4.

### 12.3 Operational requirements

1. **Set a stable `sig` secret.** A bus that mints one per boot cannot verify
   anything written before its last restart, and MUST say so (R4).
2. **Do not expose an unauthenticated bus.** It trusts its callers, in the same
   sense and to the same degree as an unauthenticated Redis.
3. **Treat `id_failures > 0` as an incident.** It means on-disk content no longer
   matches its address: tampering, or storage corruption. Neither is routine.
4. **Whitelist the environment of any child process an agent spawns.** The bus
   secret in particular MUST NOT be passed down; a spawned worker needs to
   append, and appending requires no secret.

---

## 13. Related work

This protocol is an assembly of known ideas. What is new is the combination and
the argument for why nothing else is needed.

| source | what is taken | what is left behind |
|---|---|---|
| **Blackboard architecture** (Hearsay-II, HASP) | a shared surface specialists write partial results onto and read independently; no specialist is addressed | the **control component** — the scheduler that decided which specialist ran. Total order arbitrates instead (§3.1) |
| **Stigmergy** (Grassé) | coordination via a shared medium rather than via messages; the medium holds the state | nothing — this is the guiding image (§3.1) |
| **Linda tuple spaces** (Gelernter) | a shared, associatively addressed space; producers and consumers never name each other | **destructive `in`**. A tuple taken is gone, so a late reader cannot reconstruct the world, and the space becomes a work queue. Here nothing is consumed; ownership is a fold, not a removal (§8.4) |
| **Event sourcing / CQRS** | the log is the only truth; every state is a projection | the per-aggregate boundary and the assumption of a single application's schema |
| **Kafka** | an ordered, durable, cursor-read partition | consumer groups and offsets *as protocol* — those are delivery semantics, and delivery implies a recipient (§1.3 step 2). A single signed partition is the nearest analogue to this bus |
| **Git** | content addressing, immutability, append-only history, fetch-by-cursor; identical content is one object | the merge model. There is one order, so there is nothing to merge |
| **Lamport clocks / total order broadcast** | exclusivity as a consequence of order rather than of locking | distributed agreement on the order itself. One bus assigns it (§2.4) |
| **CRDTs** | convergence without coordination | the price: restricting what may be *said* until every operation commutes. Disagreement is data here, not a conflict to resolve (§1.2) |
| **CAN bus** | content-addressed broadcast with local filtering; no node is addressed | the real-time arbitration scheme |
| **RFC 8785 (JCS)** | canonical JSON, so "the same fact" means the same bytes in every language | nothing (§5.9) |
| **The scientific method** | contestable statements, corroborated or contradicted, with no central arbiter of truth | the expectation of convergence. §8.3 explicitly does not converge |

The closest single ancestor is the blackboard, and the honest summary of this
protocol is: **a blackboard for autonomous agents, with the control component
replaced by a total order, and with every specialist free to read the whole board
forever.**

---

## Appendix A. Conformance

### A.1 Conformance targets

There are three, and an implementation MUST state which ones it claims.

**A conforming bus** implements §2.1's four duties, §5's validation, §7.1–§7.3,
§5.9, §5.10, §10.2 and §11. It MAY ignore every read filter (§7.3). It MUST NOT
serve an operational endpoint that changes a fold result (§7.5).

**A conforming reader** implements the folds of §8.1–§8.4 exactly, over a
complete prefix, with the bus-published Δ. §8.5 is optional and Experimental.

**A conforming client** obeys the authoring rules: field domains (§5), one
lifecycle ref per fact (§5.4), a `nonce` on repeatable relational facts (§9.4),
and `refs.subject` on any fact intended to become a register's current value
(§8.1).

### A.2 The vector set

A canonical cross-language conformance vector set ships with this protocol
(`conformance/vectors.json`). **It is the interop contract; prose is not.** A
vector set MUST pin, at minimum:

- **§5.9** — for each vector, the exact JCS canonical string and the resulting
  `id`. Coverage MUST include: nested key sorting; a non-BMP key (the UTF-16 vs
  code-point ordering hazard); numbers at `1e-7`, `1e-6`, `1e16`, `1e21`, and an
  integer beyond 2⁵³; a whole-number `ts`; `ts` of `-0`; unicode strings requiring
  escaping; a lone surrogate; absent vs empty `refs`; present vs absent `nonce`.
- **§8, every normative fold** — `history`, `current`, `supersededBy`,
  `isSuperseded`, `chain`, `descendants`, `trust`, `ownership`, `claimWinner`. A
  fold declared normative with no vector is not part of the contract in practice.
- **The cases where two readings diverge**, which is what a vector is *for*: a
  subject group of at least four members (to distinguish "immediate successor"
  from "latest"); two explicit successors of one fact; a register head retracted;
  a non-head member retracted; a claim expiring exactly at the Δ boundary and one
  past it; a resolve from a stranger after a claim lapsed; a resolve on a
  never-claimed fact; a release by a non-holder; a chain with a dangling ancestor
  (the gap marker); `descendants` over a fork; a vote with an unrecognized
  verdict; a self-vote; `trust` of a retracted fact; `quorum = 1`.

A cross-language verifier MUST check fold outputs, not only hashes. A verifier
that reproduces every `id` while checking no fold result gives no evidence about
§8, which is where all the meaning is.

Changing a committed vector is a **wire-breaking change**: it MUST be deliberate,
reviewed hash by hash, and declared in the commit that makes it. The converse is
the useful half of the rule — **a change that only restates the specification
must leave every vector byte-identical.** A moved vector after a pure rewrite
means the rewrite changed semantics.

---

## Appendix B. Parameters and defaults

| parameter | default | who sets it | note |
|---|---|---|---|
| **Δ — claim timeout** | 600 s | **the log** | §8.4. Published via `/info`; readers MUST use the published value and MUST NOT override it |
| Trust quorum | 2 | the reader | §8.3. MUST be ≥ 1 |
| Causation depth cap | 64 | the operator | §10.2 (M5). Bounds append-time work, not trail depth |
| Read `limit` default / max | 100 / 10 000 | the operator | §7.3 |
| Max `payload` (serialized) | 1 MiB | the operator | §5.3, `413` |
| Max `refs` keys | 64 | the operator | §5.4 |
| Max `type` / `author` / `subject` | 256 B each | the operator | §5.1, §5.2, §5.4 |
| Max `nonce` | 128 B | the operator | §5.5 |
| Max glob pattern | 256 B | the operator | §7.3. Rejected with `400`; the pattern is attacker-supplied |
| Max `interests` / `publishes` entries | 64 each | the operator | §8.5. Each entry is a glob every reader evaluates |
| Durability | fsync per append | the operator | §11.1. A relaxed policy MAY be offered and MUST be reported, because it changes what a `201` means |
| Admission rate | none | the operator | §10.3 (R2). No protocol default |

A bus MUST expose its effective values (§7.5). Note how little is configurable in
the trusted core — another consequence of §1.3 step 5. Δ is the one parameter
that is neither a reader's nor purely an operator's choice: it is part of the
meaning of the log, and it must be the same for everyone reading it.

---

## Appendix C. Versions and compatibility

### C.1 Position

**v3.0 is not wire-compatible with v2.0**, and no migration path is offered. The
canonicalization change alone re-addresses every fact, so a v2.0 log read by a
v3.0 implementation fails `id` verification on every record.

The supported transition is to **start a new log**. A v2.0 log that must be kept
should be archived and read with a v2.0 reader. This is a deliberate choice for
an alpha-stage protocol with no external implementations: a compatibility shim
would preserve the very defects §C.2 lists as breaking.

### C.2 Changes from v2.0

| change | section | kind |
|---|---|---|
| Derivation rebuilt on the shared-world-state primitive; v1 migration material deleted | §1 | editorial |
| Document restructured as a specification: system model, glossary, per-field specifications, a worked example, operation sequences, proofs, security considerations | §2, §3.3, §5, §6, §7, §9, §12 | editorial |
| Fold order follows the questions an isolated agent asks; ownership moved last and re-framed as a corollary | §8 | editorial |
| "No commands" re-argued as *no delivery semantics* rather than *addressing is unrepresentable* | §1.3 | normative clarification |
| Canonicalization replaced by **RFC 8785 (JCS)**; the `ts`-only trailing-`.0` rule deleted | §5.9 | **breaking** |
| `refs` values: empty string and `null` now rejected at append instead of silently dropped at hash time | §5.4, §10.2 | **breaking** |
| `current(S)` simplified: successors MUST carry the subject; the forward-walk is gone; reserved-namespace facts are not register members | §8.1 | **breaking** |
| `supersededBy(F)` defined as the **immediate** successor, with a stated tie-break; retracted and unauthorized successors excluded | §8.1 | **breaking** |
| A fact MUST NOT carry more than one lifecycle ref; the bus rejects it | §5.4, §8.4, §10.2 | **breaking** |
| `resolves` gate tightened to **the current claim winner only** — the ungated never-claimed path is removed | §8.4 | **breaking** |
| Δ is a property of the log, published by the bus; readers MUST NOT override it | §8.4, §B | **breaking** |
| `trust` gains a `retracted` state; `quorum` MUST be ≥ 1; an unrecognized verdict no longer occupies its author's slot | §8.3 | **breaking** |
| Folds are defined over a **complete prefix**; filtered/partial windows are non-normative | §8.0 | normative clarification |
| Dangling ancestors surface as an explicit gap marker instead of silent truncation | §8.2 | **breaking** |
| `supersedes` is now gated on the target's author, closing a trust-hijack | §5.4, §8.1, §10.1 | **breaking** |
| `tombstones` is now gated on the target's author, closing a data-destruction primitive | §8.1, §10.1, §11.2 | **breaking** |
| New: authorization model — which `refs` keys are self-asserted vs fold-gated | §10.1 | new |
| New: value domains and hard limits for every field | §5, §B | new |
| New: theorems and proofs for exclusivity, determinism, monotonicity, idempotence | §9 | new |
| New: conformance levels and what a vector set must pin | §A | new |
| Recovery MUST truncate a torn tail; a `seq` MUST NOT be reused | §11.1 | **breaking** |
| Compaction MUST NOT change any fold result; supersession alone no longer makes a payload droppable; stripped facts MUST be marked | §11.2 | **breaking** |

### C.3 Extension policy

- A new `refs` key is **additive**: a bus MUST accept unknown keys and readers
  MUST ignore keys they do not understand (M12). A new key that requires a fold
  gate is **not** additive and needs a version.
- A new fact `type` outside the reserved namespaces (§5.1) is always additive.
- A new field is **not** additive: unknown top-level fields are not stored (M13).
  Extensions go in `payload`.
- Any change to the content address, to a §8 fold, or to a §10.1 gate is
  wire-breaking and requires a major version and a regenerated vector set (§A.2).

---

<div align="center">
  <sub>

*Protocol v3.0 by Carter.Yang. The bus orders and preserves; readers decide what
it means.*

  </sub>
</div>
