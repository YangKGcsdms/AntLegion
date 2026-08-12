# @antlegion/ant

**Autonomous worker ants (DCUs) for the [AntLegion fact bus](https://www.npmjs.com/package/@antlegion/bus).**

> ⚠️ **Pre-release.** This package reserves the name while the runtime is
> packaged; today it only prints a roadmap. Follow progress at
> [YangKGcsdms/antlegion-platform](https://github.com/YangKGcsdms/antlegion-platform).

## What it will be

The missing tier every agent-coordination store leaves out: not just the
mailbox, but the **employee**. An ant is a resident work unit that:

1. **watches** the fact bus (`poll → fold`) for facts matching its trigger predicate,
2. **claims** work through the bus's exactly-once theorem (lowest-seq live claim wins — no locks),
3. **acts** — a script, or an LLM session scoped to a skill file (coordination stays in deterministic code; the LLM only does the work),
4. **resolves** with evidence facts, then goes back to sleep.

Crash-safe by construction: an ant that dies mid-task simply lets its claim
expire, and a sibling takes over — ownership transfer is a fold over the log,
not a recovery protocol.

## Planned interface

```bash
npm i -g @antlegion/ant
ant init          # guided setup: bus URL, name, watched fact types, trigger, act type
ant start         # daemon loop; wakes when facts match, works, resolves, sleeps
```

## Works today

```bash
npx @antlegion/bus     # the fact bus this package's ants will live on
```

See the [AntLegion protocol](https://github.com/YangKGcsdms/antlegion-platform/blob/master/PROTOCOL.md) —
append-only, content-addressed, coordination as reader folds.
