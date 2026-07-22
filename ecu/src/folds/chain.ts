/**
 * folds/chain.ts — shared fold of the "requirement chain" worldview.
 *
 * Pure functions over the fact stream. Two fact families are understood:
 *
 *   req.registered  payload: { slug, name, created, slot, branch, projects, ports }
 *                   emitted once per requirement dir by the ingestor.
 *   doc.updated     payload: { reqSlug, doc, status, mtime, path }
 *                   emitted on every doc write; latest-wins per (reqSlug, doc).
 *
 * The fold is deterministic: given the same fact stream it always produces
 * the same state, so every DCU and the board see the same world.
 */

export interface FactLike {
  seq: number;
  recv: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface ReqPorts {
  backend?: number;
  workflow?: number;
  ui?: number;
  llm?: number;
  debug?: number;
}

export interface Requirement {
  slug: string;
  name: string;
  created: string;
  slot: number | null;
  branch: string;
  projects: string[];
  ports: ReqPorts;
  /** seq/recv of the first req.registered fact for this slug. */
  registeredSeq: number;
  registeredRecv: number;
}

export interface DocState {
  reqSlug: string;
  doc: string;
  /** Parsed 状态 header, or null when the doc has none. */
  status: string | null;
  /** File mtime (ms) as reported by the ingestor. */
  mtime: number;
  path: string;
  /** seq/recv of the winning (latest) doc.updated fact. */
  seq: number;
  recv: number;
}

export interface ChainState {
  /** Requirements keyed by slug, ordered by registration seq. */
  requirements: Requirement[];
  /** Latest doc states per requirement slug (latest-wins per doc). */
  docsByReq: Map<string, DocState[]>;
  /** Docs whose reqSlug has no req.registered fact yet. */
  orphanDocs: DocState[];
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asSlot(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function asProjects(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((p): p is string => typeof p === "string");
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  return [];
}

function asPorts(v: unknown): ReqPorts {
  if (typeof v !== "object" || v === null) return {};
  const out: ReqPorts = {};
  for (const k of ["backend", "workflow", "ui", "llm", "debug"] as const) {
    const n = (v as Record<string, unknown>)[k];
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function requirementFrom(f: FactLike): Requirement {
  const p = f.payload;
  return {
    slug: asString(p.slug),
    name: asString(p.name),
    created: asString(p.created),
    slot: asSlot(p.slot),
    branch: asString(p.branch),
    projects: asProjects(p.projects),
    ports: asPorts(p.ports),
    registeredSeq: f.seq,
    registeredRecv: f.recv,
  };
}

function docStateFrom(f: FactLike): DocState {
  const p = f.payload;
  return {
    reqSlug: asString(p.reqSlug),
    doc: asString(p.doc),
    status: typeof p.status === "string" && p.status !== "" ? p.status : null,
    mtime: typeof p.mtime === "number" ? p.mtime : 0,
    path: asString(p.path),
    seq: f.seq,
    recv: f.recv,
  };
}

/**
 * Fold a seq-ordered fact stream into the requirement-chain worldview.
 * Facts may arrive in any order; output is ordered by seq internally.
 *
 * - requirements: first req.registered per slug wins (registration is
 *   idempotent; a re-registered slug keeps its original identity but a
 *   *later* registration refreshes mutable fields — latest-wins on payload,
 *   first-wins on registeredSeq ordering).
 * - docs: latest doc.updated per (reqSlug, doc) wins, by highest seq.
 */
export function foldChain(facts: FactLike[]): ChainState {
  const reqs = new Map<string, Requirement>();
  const docs = new Map<string, DocState>(); // key: reqSlug + "" + doc

  const sorted = [...facts].sort((a, b) => a.seq - b.seq);

  for (const f of sorted) {
    if (f.type === "req.registered") {
      const r = requirementFrom(f);
      if (!r.slug) continue;
      const prev = reqs.get(r.slug);
      if (prev) {
        // Re-registration: refresh fields, keep original registration marker.
        reqs.set(r.slug, { ...r, registeredSeq: prev.registeredSeq, registeredRecv: prev.registeredRecv });
      } else {
        reqs.set(r.slug, r);
      }
    } else if (f.type === "doc.updated") {
      const d = docStateFrom(f);
      if (!d.reqSlug || !d.doc) continue;
      const key = d.reqSlug + "" + d.doc;
      const prev = docs.get(key);
      if (!prev || d.seq > prev.seq) docs.set(key, d);
    }
  }

  const requirements = [...reqs.values()].sort((a, b) => a.registeredSeq - b.registeredSeq);
  const docsByReq = new Map<string, DocState[]>();
  const orphanDocs: DocState[] = [];

  for (const d of docs.values()) {
    if (reqs.has(d.reqSlug)) {
      const list = docsByReq.get(d.reqSlug) ?? [];
      list.push(d);
      docsByReq.set(d.reqSlug, list);
    } else {
      orphanDocs.push(d);
    }
  }
  for (const list of docsByReq.values()) {
    list.sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0));
  }
  orphanDocs.sort((a, b) => (a.path < b.path ? -1 : 1));

  return { requirements, docsByReq, orphanDocs };
}

/** Age in seconds since a requirement was registered (bus recv clock). */
export function reqAgeSeconds(req: Requirement, nowRecv: number): number {
  return Math.max(0, nowRecv - req.registeredRecv);
}
