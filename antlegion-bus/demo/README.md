# AntLegion — the killer demo

Two artifacts that make the three things queues / mailbox coordinators /
in-process frameworks can't say **visibly true**:

1. **Exactly-once assignment** across heterogeneous, independent agent
   processes — a theorem of total order, not a lock.
2. **Crash → deterministic re-dispatch** with no orchestrator — stale claims
   expire on trusted bus time (`recv + Δ`), survivors re-claim and finish.
3. **Full replay / audit** — kill the bus, restart from `facts-v2.jsonl`,
   reconstructed state is byte-identical. The log IS the state.

## A. Terminal demo (self-contained)

```bash
npx tsx examples/demo-killer.ts
```

Boots its own bus on an ephemeral port, publishes 400 tasks, spawns 8 real
child processes posing as 4 frameworks (LangGraph, CrewAI, Claude-Code-style,
plain script), SIGKILLs one mid-run, then kills and replays the bus itself.
Exits 0 on PASS, prints a VERDICT. ~20–30s.

Useful env knobs:

| var | default | meaning |
| --- | --- | --- |
| `ANTLEGION_DEMO_PORT` | ephemeral | fixed bus port (use `28090` for the dashboard) |
| `ANTLEGION_DEMO_DATA_DIR` | mktemp | journal dir; preserved if set |
| `ANTLEGION_DEMO_TASKS` | `400` | task count |
| `ANTLEGION_DEMO_DELTA` | `3` | claim timeout seconds |
| `ANTLEGION_DEMO_FSYNC` | `always` | journal fsync policy |
| `ANTLEGION_DEMO_KEEP_BUS` | – | `1` = leave a replayed bus running for the dashboard |
| `ANTLEGION_DEMO_VERBOSE` | – | `1` = stream child agent logs |

## B. Live dashboard combo

`demo/dashboard.html` is a zero-dependency single file — no build, no CDN.
Open it straight from disk; it polls `GET /facts?since=<cursor>` and `/info`
and folds task state locally with the same semantics as `src/fold.ts`.

```bash
# 1. run the demo on the dashboard's port, keeping the bus alive afterwards
ANTLEGION_DEMO_PORT=28090 \
ANTLEGION_DEMO_DATA_DIR=.demo-data \
ANTLEGION_DEMO_KEEP_BUS=1 \
npx tsx examples/demo-killer.ts

# 2. while it runs, open in a browser:
open "demo/dashboard.html?bus=http://localhost:28090&delta=3"
```

You'll watch the task grid flip open→claimed→resolved, the DUPLICATES counter
pin at 0, the killed agent's card go red DEAD while survivors absorb its
claims — and, in ACT 3, the connection pill drop to RECONNECTING and come
back LIVE on the replayed bus.

### Restart-replay by hand (the audit story)

```bash
# bus with a stable secret + journal dir
PORT=28090 ANTLEGION_BUS_SECRET=demo-killer ANTLEGION_DATA_DIR=.demo-data npx tsx src/index.ts
# … produce facts (run the demo against it, or alctl publish) …
# in the dashboard: click 📸 SNAPSHOT STATE
# Ctrl+C the bus, then restart with the SAME secret + data dir
PORT=28090 ANTLEGION_BUS_SECRET=demo-killer ANTLEGION_DATA_DIR=.demo-data npx tsx src/index.ts
# the dashboard detects the reconnect, refetches from seq 0, and shows
# "✓ REPLAY VERIFIED — state byte-identical after restart"
```

Query params: `?bus=` (default `http://localhost:28090`), `&delta=` (claim
timeout, must match the run — demo uses 3), `&stale=` (agent-alive window,
default 8s of bus time).
