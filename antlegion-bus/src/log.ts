/**
 * v2 append-only log (PROTOCOL.md §7) — the AOF of AntLegion.
 *
 * fsync policy mirrors Redis `appendfsync`:
 *   always   — fsync after every append (max durability, slowest)
 *   everysec — fsync at most once a second on a timer (≤1s loss on crash)
 *   no       — never fsync explicitly; flush on close, OS decides otherwise
 *
 * A single append-mode fd is kept open (so we don't pay open/close per write).
 * Compaction (the BGREWRITEAOF analog) writes a temp file then atomically
 * renames it; the held fd is flushed + closed first and reopened lazily, so we
 * never keep writing into the unlinked pre-rewrite inode.
 */

import {
  appendFileSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, writeFileSync, fsyncSync, closeSync,
} from "node:fs";
import { join } from "node:path";
import type { Fact } from "./types.js";

export type FsyncPolicy = "always" | "everysec" | "no";

export class JsonlLog {
  readonly path: string;
  readonly fsyncPolicy: FsyncPolicy;
  private fd: number | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir = ".data-v2", fsyncPolicy: FsyncPolicy = "always") {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "facts-v2.jsonl");
    this.fsyncPolicy = fsyncPolicy;
    if (fsyncPolicy === "everysec") {
      this.timer = setInterval(() => this.flush(), 1000);
      this.timer.unref?.(); // don't keep the process (or tests) alive
    }
  }

  private ensureFd(): number {
    if (this.fd === null) this.fd = openSync(this.path, "a");
    return this.fd;
  }

  /** fsync if there are unflushed writes. */
  flush(): void {
    if (this.dirty && this.fd !== null) {
      fsyncSync(this.fd);
      this.dirty = false;
    }
  }

  append(fact: Fact): void {
    const fd = this.ensureFd();
    appendFileSync(fd, JSON.stringify(fact) + "\n", "utf-8");
    if (this.fsyncPolicy === "always") fsyncSync(fd);
    else this.dirty = true; // flushed by timer (everysec) or on close (no/everysec)
  }

  readAll(): Fact[] {
    if (!existsSync(this.path)) return [];
    const out: Fact[] = [];
    for (const line of readFileSync(this.path, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as Fact);
      } catch {
        // torn final record — skip
      }
    }
    return out;
  }

  /**
   * Compaction (§5.2): rewrite the log keeping every skeleton, stripping the
   * payloads of `payloadDroppable` ids. Flushes + closes the live fd first, then
   * temp-file + atomic rename, then drops the fd so the next append reopens the
   * NEW file (never the unlinked pre-rewrite inode). Returns payloads stripped.
   */
  compact(facts: Fact[], payloadDroppable: Set<string>): number {
    this.flush();
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }

    const tmp = this.path + ".tmp";
    let stripped = 0;
    const lines = facts.map((f) => {
      if (payloadDroppable.has(f.id) && Object.keys(f.payload).length > 0) {
        stripped++;
        return JSON.stringify({ ...f, payload: {} });
      }
      return JSON.stringify(f);
    });
    writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
    renameSync(tmp, this.path);
    this.dirty = false;
    return stripped;
  }

  /** Flush + close. Call on graceful shutdown. */
  close(): void {
    this.flush();
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stats(): { entries: number; bytes: number } {
    if (!existsSync(this.path)) return { entries: 0, bytes: 0 };
    const content = readFileSync(this.path, "utf-8");
    return {
      entries: content.split("\n").filter((l) => l.trim()).length,
      bytes: statSync(this.path).size,
    };
  }
}
