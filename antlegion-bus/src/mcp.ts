#!/usr/bin/env node
/**
 * antlegion-mcp (v2) — MCP server adapter for the v2 fact bus.
 *
 * Exposes the bus to any MCP client (Claude Code, Cursor, Cline, …) over stdio.
 * It is a thin shell over the v2 folding SDK (ClientV2): the client surface
 * stays small (publish / query / claim / resolve / observe / causation / state)
 * while the adapter does the append-then-read-back-and-fold work. All v2
 * semantics — exactly-once claim, trust, causation — come from one place
 * (fold.ts via ClientV2), never re-implemented here.
 *
 *   ANTLEGION_BUS_URL=http://localhost:28090 ANTLEGION_AGENT_NAME=claude-code \
 *     node dist/mcp.js
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
import { fileURLToPath } from "node:url";
import { ClientV2, httpTransport } from "./client.js";

const BUS_URL = (process.env.ANTLEGION_BUS_URL ?? "http://localhost:28090").replace(/\/$/, "");
const AGENT_NAME = process.env.ANTLEGION_AGENT_NAME ?? `${hostname()}-${process.pid}`;

const client = new ClientV2(httpTransport(BUS_URL), AGENT_NAME);

const TOOLS = [
  {
    name: "antlegion_publish",
    description:
      "Publish a fact to the bus. Facts are immutable and content-addressed. To make a unit of work " +
      "exclusive, publish it and let consumers claim it; broadcast facts simply go unclaimed.",
    inputSchema: {
      type: "object",
      required: ["fact_type", "payload"],
      properties: {
        fact_type: { type: "string", description: 'Dotted name, e.g. "build.failed".' },
        payload: { type: "object", description: "Arbitrary JSON content." },
        parent_fact_id: { type: "string", description: "Causal parent fact id (sets refs.parent)." },
        subject_key: { type: "string", description: "Group key for latest-wins supersession (refs.subject)." },
      },
    },
  },
  {
    name: "antlegion_query",
    description: "Read facts. Use since_sequence for cursor-based incremental polling (pass the previous next_cursor).",
    inputSchema: {
      type: "object",
      properties: {
        fact_type: { type: "string", description: "Glob pattern, e.g. build.* " },
        since_sequence: { type: "number", description: "Return facts with seq > this." },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "antlegion_claim",
    description:
      "Claim an exclusive fact, then confirm via read-back. Exactly-once: the lowest-seq claim wins. " +
      "Returns { won, winner }. If won is false, do not retry the same fact_id — someone else owns it.",
    inputSchema: { type: "object", required: ["fact_id"], properties: { fact_id: { type: "string" } } },
  },
  {
    name: "antlegion_resolve",
    description: "Resolve a fact you claimed (honored only if you are the winner). Optionally emit child facts (causation).",
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
            properties: { fact_type: { type: "string" }, payload: { type: "object" } },
          },
        },
      },
    },
  },
  {
    name: "antlegion_observe",
    description: "Vote corroborate/contradict on someone else's fact. The bus does not adjudicate; readers fold votes into trust.",
    inputSchema: {
      type: "object",
      required: ["fact_id", "verdict"],
      properties: { fact_id: { type: "string" }, verdict: { type: "string", enum: ["corroborate", "contradict"] } },
    },
  },
  {
    name: "antlegion_causation",
    description: "Fetch the causation chain (ancestors) of a fact, root → fact.",
    inputSchema: { type: "object", required: ["fact_id"], properties: { fact_id: { type: "string" } } },
  },
  {
    name: "antlegion_state",
    description: "Lifecycle state of a fact folded from the log: open / claimed / resolved / dead (+ owner).",
    inputSchema: { type: "object", required: ["fact_id"], properties: { fact_id: { type: "string" } } },
  },
];

export async function dispatch(client: ClientV2, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "antlegion_publish": {
      const refs: Record<string, string> = {};
      if (args.parent_fact_id) refs.parent = String(args.parent_fact_id);
      if (args.subject_key) refs.subject = String(args.subject_key);
      const r = await client.publish(String(args.fact_type), (args.payload as Record<string, unknown>) ?? {}, { refs });
      return { fact_id: r.id, seq: r.seq, deduped: r.deduped };
    }
    case "antlegion_query": {
      const facts = await client.query({
        type: args.fact_type as string | undefined,
        since: args.since_sequence as number | undefined,
        limit: (args.limit as number | undefined) ?? 50,
      });
      const next = facts.reduce((m, f) => Math.max(m, f.seq), (args.since_sequence as number) ?? 0);
      return {
        count: facts.length,
        next_cursor: next,
        facts: facts.map((f) => ({
          fact_id: f.id, fact_type: f.type, seq: f.seq, author: f.author,
          created_at: new Date(f.recv * 1000).toISOString(), payload: f.payload, refs: f.refs,
        })),
      };
    }
    case "antlegion_claim":
      return client.claim(String(args.fact_id));
    case "antlegion_resolve": {
      const children = ((args.result_facts as Array<{ fact_type: string; payload?: Record<string, unknown> }>) ?? [])
        .map((c) => ({ type: c.fact_type, payload: c.payload ?? {} }));
      const r = await client.resolve(String(args.fact_id), children);
      return { ok: true, child_fact_ids: r.childIds };
    }
    case "antlegion_observe":
      await client.observe(String(args.fact_id), args.verdict as "corroborate" | "contradict");
      return { ok: true };
    case "antlegion_causation": {
      const chain = await client.causation(String(args.fact_id));
      return { chain_length: chain.length, chain: chain.map((f) => ({ fact_id: f.id, fact_type: f.type, seq: f.seq })) };
    }
    case "antlegion_state":
      return client.state(String(args.fact_id));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

const server = new Server({ name: "antlegion-mcp", version: "2.0.0" }, { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const result = await dispatch(client, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "antlegion://facts/recent", name: "Recent facts", description: "Most recent facts on the bus.", mimeType: "application/json" },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== "antlegion://facts/recent") throw new Error(`unknown resource: ${req.params.uri}`);
  const facts = await client.query({ limit: 20 });
  return { contents: [{ uri: req.params.uri, mimeType: "application/json", text: JSON.stringify(facts, null, 2) }] };
});

async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[antlegion-mcp v2] ready · bus=${BUS_URL} · agent=${AGENT_NAME}\n`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[antlegion-mcp v2] fatal: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
