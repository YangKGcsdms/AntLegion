#!/usr/bin/env node
/**
 * antlegion-mcp — MCP server adapter for AntLegion Bus.
 *
 * Exposes 6 tools and 2 resources over stdio. Any MCP-capable client
 * (Claude Code, Cursor, Cline, Continue, Windsurf, Goose, Codex CLI, …)
 * can join the bus by adding this server to its MCP config.
 *
 * Design rule: clients see "facts", "publish", "claim", "resolve".
 * Everything else (content_hash, signatures, tokens, ant identity,
 * causation depth, semantic_kind enums, …) lives inside this adapter.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUS_URL = (process.env.ANTLEGION_BUS_URL ?? "http://localhost:28080").replace(/\/$/, "");

// Identity:
// - If ANTLEGION_AGENT_NAME is explicitly set, use it verbatim. The user takes
//   responsibility for collision avoidance (e.g. setting it to "claude-code").
// - Otherwise auto-derive a name that won't collide between hosts / windows /
//   CI runs: <hostname>-<pid>. This is what gets sent as source_ant_id to
//   every bus operation.
const AGENT_NAME =
  process.env.ANTLEGION_AGENT_NAME ?? `${hostname()}-${process.pid}`;

// ─────────────────────────────────────────────────────────────────────────────
// Bus client
//
// We use AGENT_NAME directly as the source_ant_id and never register with the
// bus. The protocol accepts publish/claim/resolve from unregistered ant_ids
// (the bus simply skips reliability tracking for them). This keeps the bus
// from accumulating one phantom ant per Claude Code / Cursor restart.
// ─────────────────────────────────────────────────────────────────────────────

const SYNTHETIC_ANT_ID = AGENT_NAME;

// ─────────────────────────────────────────────────────────────────────────────
// Cursor persistence
//
// The bus is poll-only and clients drive their own scan loop. To make this
// useful across process restarts (cron-driven Codex, Claude Code reopen, etc.)
// we persist the last seen sequence_number per AGENT_NAME under
//   ~/.antlegion/cursor-<AGENT_NAME>.json
// On startup the file is loaded; every successful query updates it.
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_DIR = join(homedir(), ".antlegion");
const CURSOR_FILE = join(CURSOR_DIR, `cursor-${encodeURIComponent(AGENT_NAME)}.json`);

let lastSeenSequence = 0;
try {
  if (existsSync(CURSOR_FILE)) {
    const raw = readFileSync(CURSOR_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { last_sequence?: number };
    if (typeof parsed.last_sequence === "number" && Number.isFinite(parsed.last_sequence)) {
      lastSeenSequence = parsed.last_sequence;
    }
  }
} catch {
  // Corrupt or unreadable cursor file is non-fatal; start from 0.
}

function persistCursor(seq: number): void {
  try {
    if (!existsSync(CURSOR_DIR)) mkdirSync(CURSOR_DIR, { recursive: true });
    writeFileSync(
      CURSOR_FILE,
      JSON.stringify({ last_sequence: seq, agent_name: AGENT_NAME, updated_at: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  } catch {
    // Cursor persistence failure is non-fatal; we just lose the optimization
    // on next restart.
  }
}

async function busPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BUS_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text}`);
  return data;
}

async function busGet(path: string): Promise<unknown> {
  const res = await fetch(`${BUS_URL}${path}`);
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text}`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

type FactSummary = {
  fact_id: string;
  fact_type: string;
  state: string;
  mode: string;
  sequence_number: number;
  source_ant_id: string;
  created_at: number;
  payload: Record<string, unknown>;
};

interface QueryArgs {
  fact_type?: string;
  state?: "published" | "claimed" | "resolved" | "dead";
  since_sequence?: number;
  limit?: number;
}

async function toolPublish(args: {
  fact_type: string;
  payload: Record<string, unknown>;
  mode?: "broadcast" | "exclusive";
  priority?: number;
  parent_fact_id?: string;
  subject_key?: string;
  ttl_seconds?: number;
  domain_tags?: string[];
  need_capabilities?: string[];
}) {
  const data = (await busPost("/facts", {
    fact_type: args.fact_type,
    payload: args.payload,
    mode: args.mode ?? "broadcast",
    priority: args.priority ?? 3,
    parent_fact_id: args.parent_fact_id,
    subject_key: args.subject_key ?? "",
    ttl_seconds: args.ttl_seconds,
    domain_tags: args.domain_tags ?? [],
    need_capabilities: args.need_capabilities ?? [],
    semantic_kind: "observation",
    source_ant_id: SYNTHETIC_ANT_ID,
    content_hash: "",
    created_at: Date.now() / 1000,
  })) as { fact_id: string; state: string; sequence_number: number };
  return {
    fact_id: data.fact_id,
    state: data.state,
    sequence_number: data.sequence_number,
  };
}

async function toolQuery(args: QueryArgs) {
  // Default to the persisted cursor so repeated queries (and cron-driven
  // restarts) automatically advance instead of re-reading from 0. Callers
  // who want to scan the entire history pass since_sequence: 0 explicitly.
  const effectiveSince = args.since_sequence ?? lastSeenSequence;

  const qs = new URLSearchParams();
  if (args.fact_type) qs.set("fact_type", args.fact_type);
  if (args.state) qs.set("state", args.state);
  if (effectiveSince > 0) qs.set("since_sequence", String(effectiveSince));
  qs.set("limit", String(args.limit ?? 50));
  const facts = (await busGet(`/facts?${qs.toString()}`)) as FactSummary[];

  const maxSeq = facts.reduce((m, f) => Math.max(m, f.sequence_number), lastSeenSequence);
  if (maxSeq > lastSeenSequence) {
    lastSeenSequence = maxSeq;
    persistCursor(maxSeq);
  }

  return {
    count: facts.length,
    next_cursor: maxSeq,
    facts: facts.map((f) => ({
      fact_id: f.fact_id,
      fact_type: f.fact_type,
      state: f.state,
      mode: f.mode,
      sequence_number: f.sequence_number,
      source_ant_id: f.source_ant_id,
      created_at: new Date(f.created_at * 1000).toISOString(),
      payload: f.payload,
    })),
  };
}

async function toolClaim(args: { fact_id: string }) {
  const data = await busPost(`/facts/${args.fact_id}/claim`, {
    ant_id: SYNTHETIC_ANT_ID,
  });
  return data;
}

async function toolResolve(args: {
  fact_id: string;
  result_facts?: Array<{
    fact_type: string;
    payload: Record<string, unknown>;
    mode?: "broadcast" | "exclusive";
  }>;
}) {
  const data = await busPost(`/facts/${args.fact_id}/resolve`, {
    ant_id: SYNTHETIC_ANT_ID,
    result_facts: args.result_facts ?? [],
  });
  return data;
}

async function toolObserve(args: {
  fact_id: string;
  verdict: "corroborate" | "contradict";
  reason?: string;
}) {
  const endpoint = args.verdict === "corroborate" ? "corroborate" : "contradict";
  const data = await busPost(`/facts/${args.fact_id}/${endpoint}`, {
    ant_id: SYNTHETIC_ANT_ID,
  });
  return { ...(data as object), reason: args.reason ?? null };
}

async function toolCausation(args: { fact_id: string }) {
  const chain = (await busGet(`/facts/${args.fact_id}/causation`)) as FactSummary[];
  return {
    fact_id: args.fact_id,
    chain_length: chain.length,
    chain: chain.map((f) => ({
      fact_id: f.fact_id,
      fact_type: f.fact_type,
      state: f.state,
      sequence_number: f.sequence_number,
      created_at: new Date(f.created_at * 1000).toISOString(),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP server
// ─────────────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "antlegion-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "antlegion_publish",
      description:
        "Publish a fact to the AntLegion Bus. Facts are immutable, content-hashed, and form a causation chain. " +
        "Use broadcast mode for shared context, exclusive mode when exactly one consumer should claim and resolve it.",
      inputSchema: {
        type: "object",
        required: ["fact_type", "payload"],
        properties: {
          fact_type: { type: "string", description: "Dotted name, e.g. \"build.failed\" or \"prd.published\"." },
          payload: { type: "object", description: "Arbitrary JSON content." },
          mode: { type: "string", enum: ["broadcast", "exclusive"], default: "broadcast" },
          priority: { type: "number", minimum: 0, maximum: 7, default: 3 },
          parent_fact_id: { type: "string", description: "If set, inherits causation chain from this parent." },
          subject_key: { type: "string", description: "Stable key for auto-supersede (newest wins per subject)." },
          ttl_seconds: { type: "number", minimum: 60 },
          domain_tags: { type: "array", items: { type: "string" } },
          need_capabilities: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "antlegion_query",
      description:
        "Query facts from the bus. Use since_sequence for cursor-based incremental polling: pass the previous response's " +
        "next_cursor to get only new facts since the last call.",
      inputSchema: {
        type: "object",
        properties: {
          fact_type: { type: "string" },
          state: { type: "string", enum: ["published", "claimed", "resolved", "dead"] },
          since_sequence: { type: "number", description: "Return facts with sequence_number > this. Use the previous response's next_cursor." },
          limit: { type: "number", default: 50, maximum: 500 },
        },
      },
    },
    {
      name: "antlegion_claim",
      description:
        "Atomically claim an exclusive fact. After claiming you must eventually call antlegion_resolve. " +
        "Claim is single-winner: if another client claimed first, this returns an error and you should not retry the same fact_id.",
      inputSchema: {
        type: "object",
        required: ["fact_id"],
        properties: { fact_id: { type: "string" } },
      },
    },
    {
      name: "antlegion_resolve",
      description:
        "Mark a claimed fact as resolved. Optionally emit child facts that inherit the causation chain.",
      inputSchema: {
        type: "object",
        required: ["fact_id"],
        properties: {
          fact_id: { type: "string" },
          result_facts: {
            type: "array",
            items: {
              type: "object",
              required: ["fact_type", "payload"],
              properties: {
                fact_type: { type: "string" },
                payload: { type: "object" },
                mode: { type: "string", enum: ["broadcast", "exclusive"] },
              },
            },
          },
        },
      },
    },
    {
      name: "antlegion_observe",
      description:
        "Vote on whether someone else's fact is true (corroborate) or false (contradict). The bus aggregates votes " +
        "into the epistemic state (asserted → corroborated → consensus, or → contested → refuted).",
      inputSchema: {
        type: "object",
        required: ["fact_id", "verdict"],
        properties: {
          fact_id: { type: "string" },
          verdict: { type: "string", enum: ["corroborate", "contradict"] },
          reason: { type: "string", description: "Free-text justification (not stored on the bus, just echoed back)." },
        },
      },
    },
    {
      name: "antlegion_causation",
      description: "Fetch the full causation chain (ancestors) of a fact, ordered from root to the fact itself.",
      inputSchema: {
        type: "object",
        required: ["fact_id"],
        properties: { fact_id: { type: "string" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result: unknown;
    switch (name) {
      case "antlegion_publish":   result = await toolPublish(args as any); break;
      case "antlegion_query":     result = await toolQuery(args as any); break;
      case "antlegion_claim":     result = await toolClaim(args as any); break;
      case "antlegion_resolve":   result = await toolResolve(args as any); break;
      case "antlegion_observe":   result = await toolObserve(args as any); break;
      case "antlegion_causation": result = await toolCausation(args as any); break;
      default: throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${msg}` }],
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "antlegion://facts/recent",
      name: "Recent facts",
      description: "The most recent 20 facts on the bus, regardless of state.",
      mimeType: "application/json",
    },
    {
      uri: "antlegion://facts/pending",
      name: "Pending facts",
      description: "Facts in published or matched state, available for claim.",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  let path: string;
  if (uri === "antlegion://facts/recent") {
    path = "/facts?limit=20";
  } else if (uri === "antlegion://facts/pending") {
    path = "/facts?state=published&limit=50";
  } else {
    throw new Error(`unknown resource: ${uri}`);
  }
  const facts = await busGet(path);
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(facts, null, 2) }],
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[antlegion-mcp] ready · bus=${BUS_URL} · ant=${SYNTHETIC_ANT_ID}\n`);
}

main().catch((err) => {
  process.stderr.write(`[antlegion-mcp] fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
