/**
 * req-new.ts — native requirement creation for our own dcu-workspace.
 *
 * `req new "<中文名>" [-s slug]` creates dcu-workspace/<yyyymmddHHMM>-<slug>/
 * with docs/, logs/ and a minimal dcu.env manifest (REQ_NAME/CREATED/SLUG/
 * ORIGIN=dcu — no port-slot fields; our workspace runs no services), then
 * plans the req.registered fact with nonce `req:dcu:<dirname>` — the same
 * nonce the ingestor uses for dcu-origin roots, so `req new` and the
 * ingestor's backfill can never double-publish (bus dedups on nonce).
 *
 * Idempotency: re-running with the same slug finds the existing requirement
 * dir (dirname ends with `-<slug>`) and re-plans the fact for THAT dirname
 * instead of creating a new one — the second publish dedups on the bus.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { FactInput } from "antlegion-bus/types";
import { REQ_REGISTERED, AUTHOR, parseOawsEnv, parseReqDirName, createdToUnix } from "./dcus/ingestor-req.js";

/**
 * The bus dedups on the content id, which includes `author`. For `req new`
 * and the ingestor's backfill to dedup against each other, the fact must be
 * byte-identical — so req new publishes under the ingestor's identity. The
 * fact mirrors workspace state; the ingestor is the system of record for it.
 */
export const REQ_NEW_AUTHOR = AUTHOR;

/** dcu.env manifest content. Keep it minimal — no port-slot fields. */
export function buildDcuManifest(fields: { name: string; slug: string; created: string }): string {
  return [
    "# dcu.env — native DCU requirement manifest",
    `REQ_NAME=${fields.name}`,
    `CREATED=${fields.created}`,
    `SLUG=${fields.slug}`,
    "ORIGIN=dcu",
    "",
  ].join("\n");
}

/**
 * Slug from the requirement name when it is ASCII; otherwise null and the
 * caller must require -s. ASCII: lowercase, runs of non [a-z0-9] → "-",
 * trimmed of leading/trailing dashes.
 */
export function deriveSlug(name: string): string | null {
  if (!/^[\x20-\x7E]+$/.test(name)) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? null : slug;
}

/** Local-time `yyyymmddHHMM` stamp for dir names. */
export function stampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/** `YYYY-MM-DD HH:MM` CREATED string (matches createdToUnix). */
export function createdOf(d: Date): string {
  const s = stampOf(d);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

/**
 * Find an existing requirement dir for this slug (dirname `<stamp>-<slug>`).
 * Returns the dirname, or null. This is what makes `req new` re-runs dedup
 * instead of forking a new <stamp>- dir every minute.
 */
export async function findExistingBySlug(root: string, slug: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return null; // workspace not created yet
  }
  for (const name of names.sort()) {
    if (!parseReqDirName(name)) continue;
    if (name.endsWith(`-${slug}`)) return name;
    // fall back to the manifest SLUG when the dirname was renamed by hand
    try {
      const env = parseOawsEnv(await fs.readFile(path.join(root, name, "dcu.env"), "utf-8"));
      if (env.SLUG === slug) return name;
    } catch { /* no readable manifest — ignore */ }
  }
  return null;
}

/** The req.registered fact for a native requirement (nonce shared with the ingestor). */
export function reqNewFact(dirname: string, fields: { name: string; slug: string; created: string }): FactInput {
  return {
    type: REQ_REGISTERED,
    author: REQ_NEW_AUTHOR,
    ts: createdToUnix(fields.created) ?? 0, // deterministic: same manifest → same fact id → dedup
    payload: {
      slug: fields.slug,
      name: fields.name,
      created: fields.created,
      origin: "dcu",
      slot: null,
      branch: "",
      baseBranch: "",
      projects: [],
      ports: {},
    },
    refs: { subject: fields.slug },
    nonce: `req:dcu:${dirname}`,
  };
}

export interface CreateReqResult {
  /** Absolute path of the requirement dir. */
  dir: string;
  dirname: string;
  /** true when the dir already existed (re-run) — nothing was (re)written. */
  existed: boolean;
  fact: FactInput;
}

/**
 * Create (or find) the native requirement dir and plan its fact.
 * Never overwrites an existing manifest.
 */
export async function createRequirement(
  root: string,
  name: string,
  opts: { slug?: string; now?: Date } = {},
): Promise<CreateReqResult> {
  const slug = opts.slug ?? deriveSlug(name);
  if (!slug) {
    throw new Error(`name "${name}" is not ASCII — pass an explicit slug with -s <slug>`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`invalid slug "${slug}" — use lowercase letters, digits, dashes`);
  }

  const existing = await findExistingBySlug(root, slug);
  if (existing) {
    const dir = path.join(root, existing);
    // Re-plan the fact FROM THE MANIFEST so it is byte-identical to what the
    // ingestor publishes for the same dir — the bus dedups on content id.
    let env: Record<string, string> = {};
    try {
      env = parseOawsEnv(await fs.readFile(path.join(dir, "dcu.env"), "utf-8"));
    } catch { /* fall through to dirname-derived fields */ }
    let created = env.CREATED ?? "";
    if (!created) {
      const parsed = parseReqDirName(existing);
      created = parsed ? createdOf(new Date(
        parseInt(parsed.stamp.slice(0, 4), 10), parseInt(parsed.stamp.slice(4, 6), 10) - 1,
        parseInt(parsed.stamp.slice(6, 8), 10), parseInt(parsed.stamp.slice(8, 10), 10),
        parseInt(parsed.stamp.slice(10, 12), 10),
      )) : "";
    }
    const reqName = env.REQ_NAME || name || existing;
    return { dir, dirname: existing, existed: true, fact: reqNewFact(existing, { name: reqName, slug, created }) };
  }

  const now = opts.now ?? new Date();
  const created = createdOf(now);
  const dirname = `${stampOf(now)}-${slug}`;
  const dir = path.join(root, dirname);
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });
  await fs.mkdir(path.join(dir, "logs"), { recursive: true });
  await fs.writeFile(path.join(dir, "dcu.env"), buildDcuManifest({ name, slug, created }), "utf-8");
  return { dir, dirname, existed: false, fact: reqNewFact(dirname, { name, slug, created }) };
}
