/**
 * dcus/ingestor-req.ts — the ingestor DCU.
 *
 * Watches configured workspace roots READ-ONLY and reflects requirement
 * dirs onto the fact bus. Each root is tagged with an origin (config:
 * ecu.config.json watchRoots); every mirrored fact carries that origin:
 *
 *   req.registered  one per requirement dir  (<yyyymmddHHMM>-<名称>/)
 *                   nonce "req:<origin>:<dirname>" — reruns dedup, and the
 *                   same nonce lets `req new` and the ingestor dedup each
 *                   other for origin "dcu".
 *   doc.updated     one per docs/*.md write
 *                   nonce "doc:<relpath>:<mtimeMs>" — unchanged docs dedup,
 *                   edits republish (new mtime → new id).
 *
 * Manifest file per origin: "dcu" roots read dcu.env (our native minimal
 * manifest), other roots read oaws.env (the OA mirror schema).
 *
 * Idempotency note: the bus content-addresses facts INCLUDING `ts`, so all
 * timestamps published here are derived from the filesystem (CREATED /
 * dirname / mtime), never from the wall clock. Same workspace state → same
 * fact ids → deduped:true on re-ingest.
 *
 * Nothing here ever writes to a watched tree. Unreadable/missing files are
 * logged to stderr and skipped; the DCU keeps going.
 */

import { promises as fs, type Dirent } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { AppendResult, FactInput } from "@antlegion/bus/types";

export const REQ_REGISTERED = "req.registered";
export const DOC_UPDATED = "doc.updated";
export const AUTHOR = "ingestor-req@ant";

/** Minimal publish surface — satisfied by the bus HTTP transport. */
export interface Publisher {
  append(input: FactInput): Promise<AppendResult>;
}

export interface IngestStats {
  reqsPublished: number;
  reqsDeduped: number;
  docsPublished: number;
  docsDeduped: number;
  errors: number;
}

// ── pure parsers (unit-tested) ──────────────────────────────────────────────

/** Parse oaws.env content: KEY=value lines, optional quotes, # comments. */
export function parseOawsEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0]!;
      const last = value[value.length - 1]!;
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** Requirement dir names look like `202607201813-薪资人数漏斗追踪`. */
export function parseReqDirName(name: string): { stamp: string; title: string } | null {
  const m = /^(\d{12})-(.+)$/.exec(name);
  if (!m) return null;
  return { stamp: m[1]!, title: m[2]! };
}

/** `202607201813` → unix seconds (local time), or null when malformed. */
export function stampToUnix(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  const t = new Date(
    parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10),
    parseInt(m[4]!, 10), parseInt(m[5]!, 10),
  ).getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

/** CREATED strings look like `2026-07-20 18:13`. */
export function createdToUnix(created: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(created.trim());
  if (!m) return null;
  const t = new Date(
    parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10),
    parseInt(m[4]!, 10), parseInt(m[5]!, 10), m[6] ? parseInt(m[6], 10) : 0,
  ).getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

/**
 * Extract the 状态 header: the first line matching /^状态[:：]\s*(.+)$/
 * within the first `maxLines` lines. Returns the trimmed status text, or null.
 */
export function extractStatusHeader(content: string, maxLines = 30): string | null {
  const lines = content.split(/\r?\n/);
  const n = Math.min(lines.length, maxLines);
  for (let i = 0; i < n; i++) {
    const m = /^状态[:：]\s*(.+)$/.exec(lines[i]!.trim());
    if (m && m[1]!.trim() !== "") return m[1]!.trim();
  }
  return null;
}

// ── payload builders (pure, unit-tested) ────────────────────────────────────

export interface ReqPayload {
  slug: string;
  name: string;
  created: string;
  origin: string;
  slot: number | null;
  branch: string;
  baseBranch: string;
  projects: string[];
  ports: { backend?: number; workflow?: number; ui?: number; llm?: number; debug?: number };
}

/** Map a parsed manifest (dcu.env / oaws.env) + dir name fallback to the req.registered payload. */
export function reqPayloadFromEnv(dirname: string, env: Record<string, string>, origin = "oa"): ReqPayload {
  const parsed = parseReqDirName(dirname);
  const port = (k: string): number | undefined => {
    const v = env[k];
    return v != null && /^\d+$/.test(v) ? parseInt(v, 10) : undefined;
  };
  const ports: ReqPayload["ports"] = {};
  const p: Array<[keyof NonNullable<ReqPayload["ports"]>, string]> = [
    ["backend", "PORT_BACKEND"], ["workflow", "PORT_WORKFLOW"], ["ui", "PORT_UI"],
    ["llm", "PORT_LLM"], ["debug", "PORT_DEBUG"],
  ];
  for (const [field, key] of p) {
    const n = port(key);
    if (n != null) ports[field] = n;
  }
  return {
    slug: env.SLUG || dirname,
    name: env.REQ_NAME || parsed?.title || dirname,
    created: env.CREATED || (parsed ? stampToUnix(parsed.stamp) != null
      ? `${parsed.stamp.slice(0, 4)}-${parsed.stamp.slice(4, 6)}-${parsed.stamp.slice(6, 8)} ${parsed.stamp.slice(8, 10)}:${parsed.stamp.slice(10, 12)}`
      : "" : ""),
    origin,
    slot: env.SLOT != null && /^\d+$/.test(env.SLOT) ? parseInt(env.SLOT, 10) : null,
    branch: env.BRANCH || "",
    baseBranch: env.BASE_BRANCH || "",
    projects: (env.PROJECTS || "").split(/\s+/).filter(Boolean),
    ports,
  };
}

/** Deterministic fact ts for a req dir: CREATED, else dirname stamp, else 0. */
export function reqFactTs(dirname: string, env: Record<string, string>): number {
  if (env.CREATED) {
    const t = createdToUnix(env.CREATED);
    if (t != null) return t;
  }
  const parsed = parseReqDirName(dirname);
  if (parsed) {
    const t = stampToUnix(parsed.stamp);
    if (t != null) return t;
  }
  return 0;
}

// ── filesystem scan (read-only) ─────────────────────────────────────────────

export interface PlannedFact {
  input: FactInput;
  /** Human label for logs: dirname or doc relpath. */
  label: string;
}

export interface ScanResult {
  facts: PlannedFact[];
  errors: string[];
  /** doc relpath → mtimeMs observed this scan (for incremental watches). */
  docMtimes: Map<string, number>;
}

const emptyStats = (): IngestStats => ({
  reqsPublished: 0, reqsDeduped: 0, docsPublished: 0, docsDeduped: 0, errors: 0,
});

/**
 * Scan a requirement workspace root and plan the facts that represent it.
 * Purely observational — no publishing, no writes. Never throws on
 * unreadable entries; problems land in `errors`.
 *
 * `origin` tags every planned fact and picks the manifest filename
 * (dcu → dcu.env, anything else → oaws.env).
 */
export async function scanWorkspace(root: string, origin = "oa"): Promise<ScanResult> {
  const manifestName = origin === "dcu" ? "dcu.env" : "oaws.env";
  const facts: PlannedFact[] = [];
  const errors: string[] = [];
  const docMtimes = new Map<string, number>();

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    errors.push(`cannot read workspace root ${root}: ${msg(err)}`);
    return { facts, errors, docMtimes };
  }

  for (const ent of entries) {
    if (!ent.isDirectory() || !parseReqDirName(ent.name)) continue;
    const dir = path.join(root, ent.name);

    // req.registered
    let env: Record<string, string> = {};
    try {
      env = parseOawsEnv(await fs.readFile(path.join(dir, manifestName), "utf-8"));
    } catch (err) {
      errors.push(`${ent.name}: cannot read ${manifestName} (${msg(err)}) — registering with dirname fallbacks`);
    }
    const payload = reqPayloadFromEnv(ent.name, env, origin);
    facts.push({
      label: ent.name,
      input: {
        type: REQ_REGISTERED,
        author: AUTHOR,
        ts: reqFactTs(ent.name, env),
        payload: payload as unknown as Record<string, unknown>,
        refs: { subject: payload.slug },
        nonce: `req:${origin}:${ent.name}`,
      },
    });

    // doc.updated per docs/*.md
    const docsDir = path.join(dir, "docs");
    let docEntries: Dirent[];
    try {
      docEntries = await fs.readdir(docsDir, { withFileTypes: true });
    } catch {
      continue; // no docs dir — not an error worth logging every scan
    }
    for (const docEnt of docEntries) {
      if (!docEnt.isFile() || !docEnt.name.endsWith(".md")) continue;
      const abs = path.join(docsDir, docEnt.name);
      const rel = `${ent.name}/docs/${docEnt.name}`;
      try {
        const stat = await fs.stat(abs);
        const mtimeMs = stat.mtimeMs;
        docMtimes.set(rel, mtimeMs);
        const content = await fs.readFile(abs, "utf-8");
        const status = extractStatusHeader(content);
        facts.push({
          label: rel,
          input: {
            type: DOC_UPDATED,
            author: AUTHOR,
            ts: mtimeMs / 1000, // deterministic: same file state → same id → dedup
            payload: { reqSlug: payload.slug, doc: docEnt.name, status, mtime: mtimeMs, path: rel, origin },
            refs: { subject: `${payload.slug}/${docEnt.name}` },
            nonce: `doc:${rel}:${mtimeMs}`,
          },
        });
      } catch (err) {
        errors.push(`${rel}: ${msg(err)}`);
      }
    }
  }

  return { facts, errors, docMtimes };
}

/** Process-local mirror state for steady-state rescans. */
export interface KnownState {
  /** doc relpath → mtimeMs already published by this process. */
  docs: Map<string, number>;
  /** req dirnames already published by this process. */
  reqs: Set<string>;
}

export const newKnownState = (): KnownState => ({ docs: new Map(), reqs: new Set() });

/**
 * Publish a planned scan. When `known` is provided, facts already published
 * by this process are skipped locally (steady-state watch path); everything
 * else still relies on bus dedup (stable nonces + filesystem-derived ts).
 */
export async function publishScan(
  scan: ScanResult,
  publisher: Publisher,
  log: (msg: string) => void = (m) => console.error(`[ingestor-req] ${m}`),
  known?: KnownState,
): Promise<IngestStats> {
  const stats = emptyStats();
  for (const err of scan.errors) {
    stats.errors++;
    log(`scan error: ${err}`);
  }
  for (const planned of scan.facts) {
    if (known) {
      if (planned.input.type === DOC_UPDATED) {
        const rel = String((planned.input.payload as { path?: unknown }).path ?? "");
        const prev = known.docs.get(rel);
        const cur = scan.docMtimes.get(rel);
        if (prev != null && cur != null && prev === cur) continue; // already mirrored
      } else if (planned.input.type === REQ_REGISTERED && known.reqs.has(planned.label)) {
        continue; // already mirrored
      }
    }
    try {
      const r = await publisher.append(planned.input);
      const isReq = planned.input.type === REQ_REGISTERED;
      if (r.deduped) {
        if (isReq) stats.reqsDeduped++; else stats.docsDeduped++;
      } else {
        if (isReq) stats.reqsPublished++; else stats.docsPublished++;
        log(`${r.deduped ? "≡" : "+"} ${planned.input.type} ${planned.label} → seq ${r.seq}`);
      }
    } catch (err) {
      stats.errors++;
      log(`publish failed for ${planned.label}: ${msg(err)}`);
      throw err; // bus down → let the runtime loop handle reconnect
    }
  }
  if (known) {
    for (const [rel, mtime] of scan.docMtimes) known.docs.set(rel, mtime);
    for (const planned of scan.facts) {
      if (planned.input.type === REQ_REGISTERED) known.reqs.add(planned.label);
    }
  }
  return stats;
}

/** One full pass: scan + publish. Used for cold-start backfill and rescans. */
export async function backfill(
  root: string,
  publisher: Publisher,
  log?: (msg: string) => void,
  known?: KnownState,
  origin = "oa",
): Promise<IngestStats> {
  const scan = await scanWorkspace(root, origin);
  return publishScan(scan, publisher, log, known);
}

// ── steady-state watcher ────────────────────────────────────────────────────

export interface WatcherHandle {
  close(): void;
}

/**
 * Watch the workspace for changes. fs.watch on macOS is flaky for new dirs,
 * so a full rescan runs every `rescanMs` regardless; watch events only make
 * the loop react faster. Everything is debounced into one backfill pass.
 */
export function startWatcher(
  root: string,
  publisher: Publisher,
  log: (msg: string) => void,
  rescanMs = 5000,
  known: KnownState = newKnownState(),
  origin = "oa",
): WatcherHandle {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;
  let closed = false;
  let watcher: FSWatcher | null = null;

  const pass = async () => {
    if (running) { pending = true; return; }
    running = true;
    try {
      await backfill(root, publisher, log, known, origin);
    } catch {
      // publisher threw (bus down) — surface once; next pass retries
      log("publish pass failed — will retry on next tick");
    } finally {
      running = false;
      if (pending && !closed) { pending = false; void pass(); }
    }
  };
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void pass(); }, 250); // debounce bursts
  };

  try {
    watcher = watch(root, { recursive: true }, schedule);
    watcher.on("error", (err) => log(`fs.watch error (${msg(err)}) — rescan fallback still active`));
  } catch (err) {
    log(`fs.watch unavailable (${msg(err)}) — rescan fallback only`);
  }
  const interval = setInterval(schedule, rescanMs);

  void pass(); // immediate first steady-state pass (cold start already ran)

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      watcher?.close();
    },
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
