# Evolution notes — why the runtime got cut

This file documents why the trunk was trimmed from a 5-agent collaboration
platform down to "bus + MCP adapter". Future contributors deserve to know what
was tried and why it was retired.

## The original ambition (v0, now on `archive/legacy-emergent-runtime`)

The first version shipped:

- `antlegion-bus/` — the fact bus (kept on trunk)
- `antlegion/` — a 3,000-line TypeScript runtime that booted a single agent,
  registered it on the bus, and ran a sense → triage → LLM → tool-loop loop
- `antlegion-bus-ui/` — a Vue dashboard
- `workspaces/{product, ui, backend, frontend, tester}/` — five agents, each
  with a SOUL.md (persona) + role.yaml (publish/claim allowlist) + skills/*.md
- A `start.sh` that spun all of this up in docker-compose for an "auto-SDLC"
  demo: throw in a Todo CRUD requirement, watch five agents collaborate to
  produce code.

The bus protocol was the hard, original work. The five-agent SDLC demo was the
visible story.

## What broke

Reviewing the trunk we found:

1. **Critical bugs** prevented the demo from running on a clean Linux host
   (env-var mismatch on the bus secret; container `USER node` couldn't write to
   root-owned bind mounts; `start.sh` forced `--build` every time; the
   placeholder LLM key passed validation, so containers crashed in a tight
   restart loop).

2. **Task ⊥ mechanism mismatch.** SDLC has a strong partial order
   (PRD → API → frontend → test). The fact bus is a *causal-but-unordered*
   medium. The runtime tried to bridge this gap by writing the order into
   SOUL.md prose ("you must wait for both design.published *and*
   api.published"). Order-as-prose is order-as-suggestion; the LLM was free
   to ignore it, and sometimes did.

3. **Contradictory instructions.** The runtime-injected `role-guidance`
   section said "do NOT use `legion_bus_query` to poll." Each gating SOUL.md
   said "use `legion_bus_query` to check whether the other prerequisite has
   arrived." LLM compliance was unpredictable.

4. **The runtime was a closed ecosystem.** Connecting an external agent
   (Claude Code, Cursor, Cline, Continue, Codex CLI, …) required
   re-implementing the WebSocket reconnect, content-hash, ant registration,
   and claim semantics in their language and runtime. Nobody was going to do
   that. The "5-agent SDLC demo" was the only client.

5. **No e2e validation.** 178 unit tests passed. Zero tested the end-to-end
   claim "five agents produce a runnable Todo CRUD app."

## The reframe

After two rounds of structured self-review (recorded in the PR history of the
review branch), the conclusion was:

> The fact bus is the durable asset. The 5-agent runtime existed because no
> external agent could speak the protocol. The right fix is not "make the
> runtime better." It is "make the protocol speakable by everyone."

MCP (Model Context Protocol) became the universal lingua franca for
LLM-driven clients during 2024–2025. By 2026, Claude Code, Cursor, Cline,
Continue, Windsurf, Goose, Codex CLI, Zed, and Manus's open-source variants
all support it. One MCP adapter unlocks all of them at once.

## What we kept

- `antlegion-bus/` — the protocol. Bug-fixed (env var name, TTL defaults) and
  given a cursor-based `?since_sequence=N` query for client-driven polling.
  No protocol-breaking changes.
- The two-axis state model, content_hash signing, causation chain, supersede,
  corroborate/contradict, JSONL recovery, TTL sweep, GC, log compaction.
  These are the parts no other fact bus has.

## What we cut

- `antlegion/` — the runtime. Retired. Its responsibilities (loop, tool use,
  session, fact memory, context buffer, claim guard, plugins) move to
  whatever MCP client picks up the bus. The "right" runtime for a Claude Code
  user is Claude Code; for a Cline user, Cline.
- `antlegion-bus-ui/` — the dashboard. Removed for now. If we need
  observability, an MCP resource (`antlegion://stats`) or a tiny read-only
  HTML page is cheaper than a Vue SPA.
- `workspaces/{product, ui, backend, frontend, tester}/` — the five SOUL.md
  agents. Retired. The reasoning above (task ⊥ mechanism mismatch) means we
  do not believe this collaboration model can be made to work in prose alone.
  If we want to revisit "agents that coordinate through facts", we will start
  with one role at a time, validate end-to-end, and only generalize once a
  single role consistently produces useful output.
- `start.sh`, `submit-task.sh`, `watch.sh` — replaced by `docker compose up`
  plus client-side configuration.
- `FACT-FLOW.md`, `PROJECT_SUMMARY.md` — the SDLC narrative. The README now
  carries the new, smaller story.
- `antlegion-bus/DESIGN.md`, `antlegion-bus/PROGRESS.md` — implementation
  design and phase tracking for the old runtime-coupled era. Their useful
  protocol content was folded into the root [PROTOCOL.md](PROTOCOL.md).
- `antlegion-bus/protocol/{SPEC, EXTENSIONS, IMPLEMENTATION-NOTES}` (six
  files, English + Chinese). Merged into a single unified
  [PROTOCOL.md](PROTOCOL.md) at root, with §12 (Node Implementation
  Responsibilities) and Appendix C (Agent Decision Guide) removed — those
  now live in the MCP adapter.
- The `docs/` subdirectory. All documentation now lives at the project root
  for discoverability.

## Where to find the old code

```
git checkout archive/legacy-emergent-runtime
```

Or browse: https://github.com/YangKGcsdms/antlegion-platform/tree/archive/legacy-emergent-runtime

That branch is intentionally frozen. Bugs are not being fixed. It exists for
provenance: if a future contributor wants to see what was tried and revive
some idea, the source is right there.

## Principles inherited going forward

1. **The bus protocol is sacred.** Changes to facts, signatures, state
   machines, or REST endpoints break every client. Treat them like a wire
   format and follow normal protocol-versioning hygiene.

2. **Adapters carry the complexity.** Anything a client would otherwise
   have to know — hashing, tokens, semantic kinds, causation depth —
   lives inside `antlegion-mcp/` or its future siblings, not in the
   client-visible surface.

3. **Polling > pushing for fact stores.** The bus exposes a cursor. Clients
   decide their cadence. We will not be re-adding WebSocket per-ant push.

4. **No orchestrator on trunk.** If a use case needs strict workflow
   ordering, that orchestration is the client's problem, not the bus's.
   The bus offers `exclusive` mode and `subject_key` supersede; that is the
   coordination it will provide.

5. **No claim of "production-ready" without an e2e test.** Until there is a
   green CI job that exercises a real client against a real bus and asserts
   on a measurable outcome, README language stays at "alpha."
