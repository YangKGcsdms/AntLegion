# @antlegion/ant — resident agents on the shared world-state log

An **ant** here is a resident agent that lives on an [AntLegion log](https://www.npmjs.com/package/@antlegion/bus):
it mirrors the totally-ordered fact stream, **re-folds its own view of the
world** on every batch, wakes when the facts it cares about appear, and
deposits what it did back as facts. Nothing addresses it and it addresses
nothing — like an ant reading pheromone on the ground.

**DCU** = *Domain Control Unit* is the older, technical name for the same
thing, borrowed from a car's electronic architecture: on a CAN bus no central
computer gives orders — each control unit listens for the message IDs it cares
about and acts when its local condition holds. A DCU is a thin, deterministic
loop over the log. No orchestrator, no DCU addressing another. If several DCUs
end up forming a pipeline, that pipeline is a shape readers fold out of the
stream *afterwards*, never a state any component holds.

> **What this package is, and isn't.** The runtime (`runtime.ts`: mirror →
> fold → act), colony identity, residency (`ant init` / `ant start`), the
> read-only `ingestor-req` that mirrors a filesystem's truth onto the log, and
> the identity/liveness folds are the product: they keep an isolated agent's
> view of the world current. The **dev-chain** shipped alongside is a
> *workflow client example* — one way to build a staged process on top of a
> shared world — not what the log or this package is for. AntLegion is not a
> multi-agent collaboration framework; see the [root README](../README.md).

```
poll(since cursor) → rebuild shared fold → evaluate trigger → act → advance
```

## Quick start

```bash
npx @antlegion/bus                    # terminal 1 — a fact bus on :28090
npx @antlegion/ant chain              # terminal 2 — the dev-chain DCU fleet
npx @antlegion/ant req new "试点需求" -s pilot    # terminal 3 — feed it work
npx @antlegion/ant board              # supervision board → http://localhost:28091/devchain.html
```

Within ~2s of `req new`, `dcu-plan` claims the requirement (exactly-once, by
lowest seq), produces `plan.ready`, the adjudicator checks its evidence shape,
and the chain parks at the H1 human gate — approve it on the board and
dev → unittest → e2e run themselves to ✔ CHAIN DONE. `ant --help` lists all
commands; an optional `./ant.config.json` configures the bus URL and watch
roots (`ANTLEGION_BUS_URL` overrides).

> `ant init` (guided setup) and `ant start` (resident daemon) land in 0.2.

### LLM acts + the unattended MVP run

The act step can route through an LLM (pi-ai → DeepSeek) while every bit of
coordination — the loop, folds, claims, evidence shapes — stays deterministic
code. The LLM produces content; it cannot choose what to listen to or claim:

```bash
export DEEPSEEK_API_KEY=sk-…             # never committed
ANT_WORKER=llm ant chain                  # fleet with LLM acts
ANT_AUTO_GATE=1 ANT_WORKER=llm ant chain  # + auto-approved gates (unattended)

ANT_WORKER=llm ant mvp --reqs 25          # throughput run: feeds 25 requirements
# → 100 stage cycles (trigger → claim → llm act → resolve), 100 adjudications,
#   25 gate approvals; prints a scoreboard with LLM token usage at the end
```

`ANT_LLM_MODEL` (default `deepseek-v4-flash`) and `ANT_LLM_BASE_URL`
(default `https://api.deepseek.com`) select the model; any OpenAI-compatible
endpoint works. A malformed completion degrades to a valid deterministic
fallback — the chain never stalls on a bad generation.

This package ships three layers, built up in steps:

- **Step 0–2** — the bus lifecycle + the `ingestor-req` DCU that mirrors
  requirement workspaces onto the bus, plus a live requirement board.
- **Step 3** — the **dev-chain**: six DCUs that run Carter's
  `requirement-dev-flow` skill pipeline as autonomous, fact-coordinated units,
  plus a supervision board.

`ingestor-req` is documented inline below. The dev-chain is documented first
only because it is the longest worked example — read it as *one client of a
shared world*, not as the shape every ant must take.

---

## The dev-chain: six DCUs

Carter's 11-step delivery flow (`requirement-dev-flow`) collapses onto the bus
as **four stage DCUs + one adjudicator + one watchdog**. Each stage DCU knows
exactly one sentence: *"when the shared fold says my stage is `open` for some
requirement and nobody holds the claim, I claim it."* It wins the claim
(exactly-once by lowest `seq`), does the work, and resolves the input fact with
its artifact as a causal child (`refs.parent`). Losers back off; a crashed
winner's claim expires and a survivor re-runs. S9–S11 stay human.

| DCU | listens | gate | produces | evidence shape (missing → rejected) | ≈ skill |
|---|---|---|---|---|---|
| `dcu-plan` | `req.registered` | — | `plan.ready` | `scope` / `out_of_scope` / `acceptance` | requirement-breakdown · codebase-research · cross-system-solution |
| `dcu-dev` | `plan.ready` | **H1** | `dev.done` | `branch` / `changed_files` / `consumers_checked` | parallel-requirement-workspace · dev-flow S3–S4 |
| `dcu-unittest` | `dev.done` | — | `test.unit.report` | `passed` / `failed` / **`not_covered`** | springboot-jdk8-cli · dev-flow S5 |
| `dcu-e2e` | `test.unit.report` | — | `e2e.report` | `api_assertions` / **`page_checked`** / `deviations` · `defects` · `gaps` | integration-debugging · dev-flow S6–S8 |
| `dcu-adjudicator` | *all artifacts* | — | `evidence.accepted` / `evidence.rejected` | — (it judges the others) | — |
| `dcu-watchdog` | *everything (`*`)* | — | `chain.starved` / `escalate.human` | — (it detects exceptions) | — |

The stage table is a **predicate**, not a runtime limit. A DCU mirrors the
whole stream; "listens" is just its filter. The adjudicator and watchdog are
already multi-listen / multi-produce — nothing stops a stage from doing the
same. See [Multi-listen, multi-produce](#multi-listen-multi-produce).

### Evidence shapes: 做完了 ≠ 验证过了 as structure

The most valuable thing in Carter's flow is the discipline *"done ≠ verified."*
The dev-chain makes it structural: **resolving is not a declaration, it is
submitting evidence.** The adjudicator checks each artifact's payload against
the shape its producer registered; a wrong shape publishes `evidence.rejected`
and the chain **halts at that stage** until reworked. Concretely:

| naïve conclusion | the flow's counter-discipline | machine-checkable shape |
|---|---|---|
| compiled = correct | grep every consumer before changing an invariant | `dev.done` must carry `consumers_checked[]` |
| unit tests pass = behaviour correct | the report must enumerate what it *didn't* cover | `test.unit.report` without `not_covered` = invalid |
| API green = page correct | 27/27 endpoints green, page still shows `-` | `e2e.report` needs `page_checked: true` + assertions |
| a pass-rate = a report | the report must have deviations / defects / gaps | all three sections present or it isn't `accepted` |

An artifact that skips its evidence is, on the bus, equivalent to work never
done — a survivor reclaims and redoes it.

### The two cross-cutting DCUs

- **`dcu-adjudicator`** — listens to all four artifact types, validates the
  evidence shape from the registry, publishes one verdict per artifact
  (`refs.verdict_of`). It is the single writer of trust in the chain;
  downstream stages fold on its verdict, never on the raw artifact.
- **`dcu-watchdog`** — listens to everything, produces *only exceptions*, never
  claims and never advances the chain. Three conditions, each keyed on a fact
  id for idempotency:
  - `chain.starved` — a stage is `open` past a threshold with no claim (dead
    domain / wrong predicate). Anchored on the *latest prerequisite's* `recv`
    (input verdict / gate approval), not the requirement's birth.
  - `escalate.human` on **claim churn** — one input burned ≥ N claims with no
    resolve (crash-looping worker: a poison pill).
  - `escalate.human` on **rejected evidence** — an artifact the adjudicator
    shot down (including stray artifacts not on any chain).

---

## The supervision board

`devchain.html` (served at `:28091`) is the supervisor's whole interface. It
folds everything client-side from `GET /facts` — same semantics as
`src/folds/`. Four sections, top to bottom:

1. **例外收件箱 (exception inbox)** — *the only place a human looks.* Gated
   approvals (with a **批准 H1** button), escalations, and starvation. Items
   self-clear when their condition no longer holds in the fold. **Empty inbox =
   autonomous operation.** The H1 button is the only write the board makes: it
   publishes `gate.approved` as `carter@board`.
2. **DCU nodes** — one card per DCU, each answering four questions:
   - **职责 (duty)** — what it reacts to → gate → claims → produces, plus its
     evidence shape spelled out.
   - **来历 (origin)** — the `sys.registry` fact that *is* its registration
     (registration = the act of publishing; no central registrar) + which
     skills it compresses.
   - **现在 (now)** — its current claim (`● working: slug · stage`) or idle.
   - **履历 (footprint)** — cumulative counts + its recent authored facts, in
     plain language (`#23 produced plan.ready ✓adjudicated`).
3. **dev chain** — the per-requirement pipeline, one stage chip each, gates and
   verdicts inline.
4. **fact stream** — the tail of the total order.

The roster is not hard-coded — it is folded from `sys.registry` facts, so a new
DCU appears the moment it registers.

---

## Run

Installed (`npm i -g @antlegion/ant`) or via `npx @antlegion/ant`:

```bash
ant chain                # the dev-chain fleet in the foreground
                         # (each DCU its own identity + loop, one process)
ant board                # supervision board (:28091)
# open http://localhost:28091/devchain.html?bus=http://localhost:28090
# (the requirement board is still at board.html)
```

Drive a requirement end to end:

```bash
ant req new "你的需求名" -s your-slug   # publishes req.registered
# → dcu-plan claims it within ~2s, produces plan.ready, adjudicator accepts,
#   the chain parks at H1. Click 批准 H1 on the board (or POST gate.approved);
#   dev → unittest → e2e then run themselves to ✔ CHAIN DONE.
```

Working from the repo instead, `ant/scripts/up.sh` brings up bus + ingestor +
fleet + board idempotently and `ant/scripts/down.sh` stops everything.

Workers are **simulated** in Step 3 (deterministic payloads + a short sleep):
this validates the *mechanics* — claim, gate, adjudicate, chain, escalate —
before wiring real work. Swapping a simulated worker for a headless-agent spawn
(`claude -p "<work packet>" --cwd <worktree>`, `codex exec …`) changes only the
worker body in `src/dcus/devchain-dcus.ts`; **the bus contract is identical.**
That is the intended Step 4.

---

## Multi-listen, multi-produce

A DCU is not limited to one input or one output — the loop already hands
`onBatch` the full mirror, so "listens" is only a predicate you write:

- **Multi-listen** is a predicate union — free. `dcu-adjudicator` already
  listens to four types; `dcu-watchdog` to all.
- **Multi-produce** is already supported: `client.resolve(F, children[])`
  takes an array, and every child is stamped with `refs.parent: F` (causation)
  automatically. One resolve can emit several artifacts.
- **Discipline:** the claim unit is still *one fact* (exactly-once is a theorem
  at that grain). Multi-produce is for **cross-cutting domains** (a doc-sync
  DCU listening to `dev.done` + `e2e.report`; a real headless agent that edits
  code + writes tests + updates docs in one run) — *not* for collapsing the
  vertical chain into one omni-DCU, which would delete the orchestrator from
  the architecture and grow it back inside a node (you'd lose per-stage claim
  takeover, per-artifact adjudication, and stage-level observability).
- **Caveat:** meaning lives in the reader. If a DCU emits a new artifact shape,
  the domain's fold must be re-legislated to understand it — which is exactly
  what the `sys.registry` + shared-fold design is for.

---

## Facts

| type | payload | refs |
|---|---|---|
| `req.registered` | `{slug,name,created,origin,slot,branch,projects,ports}` | `subject:<slug>` |
| `doc.updated` | `{reqSlug,doc,status,mtime,path,origin}` | `subject:<slug>/<doc>` |
| `sys.registry` | `{domain,dcu,role?,worker,stage?,listens,produces,evidence_required?,skills?}` | — |
| `plan.ready` · `dev.done` · `test.unit.report` · `e2e.report` | stage evidence (see table) | `parent:<input>`, `subject:<slug>` |
| `gate.approved` | `{gate,reqSlug,note}` | `gate_of:<artifact>` |
| `evidence.accepted` / `evidence.rejected` | `{stage,checked?/missing?}` | `verdict_of:<artifact>` |
| `chain.starved` | `{reqSlug,stage,openForS}` | `starves:<input>` |
| `escalate.human` | `{reqSlug,stage,reason,detail}` | `escalates:<input/artifact>` |

`sys.registry` facts are published with `ts:0` and a stable nonce, so a
restart re-publishes byte-identical content and the bus dedups — registration
is idempotent and needs no coordination.

---

## Layout

```
src/runtime.ts            the DCU loop primitive (runDCU / DCUSpec / DCUContext)
src/folds/chain.ts        requirement-chain fold (ingestor board)
src/folds/devchain.ts     dev-chain registry + evidence rules + fold
src/folds/watchdog.ts     starvation / escalation detection (pure)
src/dcus/ingestor-req.ts  the ingestor DCU (READ-ONLY on watched roots)
src/dcus/devchain-dcus.ts the four stage DCUs + adjudicator (+ fleet factory)
src/dcus/watchdog-dcu.ts  the watchdog DCU
src/main.ts               the `ant` CLI: chain | ingestor | board | req new "<名称>" [-s slug]
devchain.html             supervision board (inbox + DCU nodes + chain)
board.html                requirement-chain board (Step 1)
scripts/up.sh|down.sh     lifecycle (idempotent, no orphans)
```

## Test

```bash
cd ant
npm install
npx tsc --noEmit
npx vitest run        # 71 tests: folds (chain / devchain / watchdog),
                      # evidence rules, env + status-header parsers,
                      # ingestor backfill, req-new manifest/nonce, config
```

The dev-chain and watchdog fold tests pin the shared worldview: every DCU and
the board fold the same stream into the same state, the evidence rules encode
`做完了 ≠ 验证过了`, and a rejected artifact provably halts the chain. Tests use
in-memory fact streams and tmpdirs — they never touch the live bus or the real
workspace.

---

## `ingestor-req` (Step 1–2)

The first DCU: it mirrors requirement workspaces onto the bus, **read-only**.
It watches every configured root (`ant.config.json` → `watchRoots`, each tagged
with an `origin`) via `fs.watch` + a 5s rescan fallback, and publishes
`req.registered` per requirement dir and `doc.updated` per doc write. Published
`ts` values derive from the filesystem (never the wall clock), so re-ingesting
an unchanged workspace yields `deduped:true` and no new facts.

Native requirements are created by the DCU system itself:

```bash
ant req new "<名称>" -s <slug>
# creates dcu-workspace/<yyyymmddHHMM>-<slug>/{dcu.env, docs/, logs/}
# and publishes req.registered (nonce req:dcu:<dirname>, origin dcu)
```

`req new` and the ingestor's backfill plan byte-identical facts for the same
dir (shared nonce), so whoever publishes second dedups — no double-publish.
The default watch root is the native `dcu-workspace/`; the OA mirror is off by
default (see `src/config.ts`).
```
