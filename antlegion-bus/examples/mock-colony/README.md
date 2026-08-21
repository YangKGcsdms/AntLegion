🌐 **English** · [简体中文](README.zh-CN.md)

# mock colony — twelve isolated processes against one log

```bash
npx tsx examples/mock-colony/colony.ts            # the run; exit 0 only if every check passes
npx tsx examples/mock-colony/colony.ts --verbose  # with each agent's own log lines
npx tsx examples/mock-colony/fold-cost.ts         # what a normative answer costs the reader
```

## Why this exists

The four `scenario-*.ts` files run several clients over real HTTP but inside
**one Node process** — one event loop, one clock, one fetch stack, one crash
domain. The protocol's central claim is about agents that share none of that, so
those scenarios cannot test it: a shared event loop serializes what the protocol
promises to arbitrate.

This harness spawns each agent as its **own OS process** and gives it exactly two
facts about the world: a bus URL and its own name. No agent receives a task list,
a peer list, a phase schedule, or a shutdown signal.

The run's phase is itself a subject register on the log, which every agent folds.
So the harness coordinates the way the protocol says to — and if that did not
work, the harness could not run at all.

## The colony

| agents | role | what it is for |
|---|---|---|
| 4 | `worker` | race for 24 tasks; claim → work → resolve; each resubmits its own claim byte-for-byte |
| 2 | `sensor` | write and revise subject registers |
| 2 | `auditor` | cold readers; fold the whole world into a sha256 |
| 1 | `crasher` | takes two claims, then dies holding them |
| 1 | `mallory` | adversary: five malformed facts, four gated ones |
| 1 | `retractor` | takes its own register head back |
| 1 | `chainer` | a 5-deep causal chain, plus one leaf whose parent never arrives |

Δ is 4 seconds (`ANTLEGION_CLAIM_TIMEOUT`) so a lapsed claim is observable inside
a short run, and the journal is `fsync`-per-append so the crash test is exact.

## What it checks

| § | claim | how it is put at risk |
|---|---|---|
| §9.1 | exclusivity | 5 agents race for 24 tasks. Two agents concluding they won the same task is the failure |
| §8.4 §9.3 | crash re-dispatch, absorbing states | the crasher dies holding claims; they must lapse and complete elsewhere, and a real resolve must never be undone |
| §9.4 | idempotence | every worker resubmits its own claim; the bus must return the same `seq` with `deduped` |
| §5 | field domains | non-finite `ts`, malformed `type`, empty `refs` value, two lifecycle refs, array payload — all must be refused |
| §10.1 | fold gates | a stranger's tombstone, a stranger's supersede, a resolve on a never-claimed fact, a release never held. **The bus accepts all four** — it does not judge meaning — and the readers must refuse to honour any |
| §8.1 | registers | a retracted head folds to `null`, never back to the previous value |
| §8.2 | trails | an unresolved ancestor surfaces as an explicit gap marker |
| §9.2 §11.1 | determinism across a crash | SIGKILL the bus, replay the journal, and fold **the same pinned prefix** again |

## Two things the harness had to learn the hard way

Both are recorded here because they are easy to repeat and they invalidate
results silently rather than loudly.

**A fixed port measures whoever answers.** `npx tsx` puts a shell and two node
processes between the orchestrator and the server, so killing the child it holds
a handle to does not always kill the listener. A surviving bus then answered the
*next* run's health check, and that run happily measured the previous run's log —
fact counts doubled on every invocation and every check still passed. The fix is
a per-run port, a detached process group, and a boot that refuses to proceed
unless the log it just started is empty. This is the same question
`dsh-antlegion/check.js` asks before pointing an agent at a bus.

**Comparing folds taken at different heads tests nothing.** The first version
folded the world before the crash and again after, then compared the hashes —
and they differed, because the harness's own probes had appended facts in
between. §9.2's boundary says exactly this: two readers at different `N` may
differ, and that is latency rather than disagreement. The comparison only means
something when the head is pinned, so both sides are asked the same question.

## Output

Every check prints ✓ or ✗, and the process exits non-zero if any failed. Findings
that are *not* pass/fail — a measurement worth stating, or a place where the
specification and the observed behaviour do not line up — print under `notes`.
