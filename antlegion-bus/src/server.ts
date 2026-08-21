/**
 * v2 wire server (PROTOCOL.md §2) — the entire surface: one write, one read,
 * two read conveniences. Wraps the stateless BusV2 core in Hono routes.
 *
 *   POST /facts            append (idempotent by id)
 *   GET  /facts            read a filtered window of the ordered stream
 *   GET  /facts/head       { head_seq } — start a reader at "newest only"
 *   GET  /facts/:id        one fact by content address
 *   GET  /health
 *   GET  /dashboard        the zero-dependency live dashboard (read-only:
 *                          it only polls /facts + /info)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { BusV2 } from "./bus.js";
import type { ReadQuery } from "./bus.js";
import type { FsyncPolicy } from "./log.js";
import { FactRejected, type FactInput } from "./types.js";

/** Hard cap on a single read window (review M2): a valid-but-huge `limit` is
 *  clamped to this so one request can never stream an unbounded log. Readers
 *  page through larger ranges with the `since` cursor. */
const MAX_READ_LIMIT = 10_000;

const DASHBOARD_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "dashboard.html",
);
const CONSOLE_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "console", "console.html",
);

export function createServerV2(opts?: {
  secret?: string; dataDir?: string; fsync?: FsyncPolicy; maxDepth?: number; claimTimeout?: number;
}) {
  const bus = new BusV2(opts);
  const app = new Hono();
  app.use("*", cors());

  app.get("/health", (c) => c.json({ status: "ok", protocol: "3.0", head_seq: bus.headSeq() }));

  // Live dashboard — a static page that reads the public wire surface.
  app.get("/dashboard", async (c) => {
    try {
      const html = await fs.readFile(DASHBOARD_HTML, "utf-8");
      return c.html(html);
    } catch {
      return c.json({ error: "dashboard not bundled in this install" }, 404);
    }
  });

  // Ops console (read-only tail -f + INFO) — same pattern, same guarantees.
  app.get("/console", async (c) => {
    try {
      const html = await fs.readFile(CONSOLE_HTML, "utf-8");
      return c.html(html);
    } catch {
      return c.json({ error: "console not bundled in this install" }, 404);
    }
  });

  // INFO (redis INFO analog) + rewrite (BGREWRITEAOF analog)
  app.get("/info", (c) => c.json(bus.info()));
  app.post("/admin/rewrite", (c) => c.json({ stripped: bus.rewrite() }));

  app.post("/facts", async (c) => {
    let body: FactInput;
    try {
      body = (await c.req.json()) as FactInput;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    // §1.1's domains are enforced in the core (types.ts), so this route only
    // has to carry the status back out: 400 well-formedness, 413 a §8 limit.
    try {
      const r = bus.append(body);
      return c.json(r, r.deduped ? 200 : 201);
    } catch (err) {
      if (err instanceof FactRejected) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  app.get("/facts/head", (c) => c.json({ head_seq: bus.headSeq() }));

  app.get("/facts/:id", (c) => {
    const fact = bus.get(c.req.param("id"));
    if (!fact) return c.json({ error: "not found" }, 404);
    return c.json(fact);
  });

  app.get("/facts", (c) => {
    const q: ReadQuery = {};
    const since = c.req.query("since");
    const limit = c.req.query("limit");
    // Validate cursor params (review M2). parseInt("abc")=NaN, and `?? default`
    // does NOT catch NaN — an unvalidated NaN made `seq <= NaN` / `len >= NaN`
    // both false, so a single junk query streamed the ENTIRE log (a DoS surface
    // on an unauthenticated bus). Reject non-integer / out-of-range explicitly.
    if (since != null) {
      const n = Number(since);
      if (!Number.isInteger(n) || n < 0) return c.json({ error: "since must be a non-negative integer" }, 400);
      q.since = n;
    }
    if (limit != null) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1) return c.json({ error: "limit must be a positive integer" }, 400);
      q.limit = Math.min(n, MAX_READ_LIMIT); // clamp: a valid-but-huge limit can't drain the whole log in one request
    }
    const type = c.req.query("type");
    const author = c.req.query("author");
    if (type) q.type = type;
    if (author) q.author = author;
    // refs.<key>=<id> — match a single relational key
    for (const [k, v] of Object.entries(c.req.query())) {
      if (k.startsWith("refs.") && v) {
        q.ref = { key: k.slice("refs.".length), value: v };
        break;
      }
    }
    const facts = bus.read(q);
    const maxSeq = facts.reduce((m, f) => Math.max(m, f.seq), q.since ?? 0);
    c.header("X-Max-Seq", String(maxSeq));
    return c.json(facts);
  });

  return { app, bus };
}
