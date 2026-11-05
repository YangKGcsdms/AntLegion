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
  renameSync, statSync, writeFileSync, fsyncSync, closeSync, truncateSync,
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
  private entries = 0;
  /** Bytes discarded from an interrupted final append during recovery. */
  recoveredTailBytes = 0;

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
    this.entries++;
    if (this.fsyncPolicy === "always") fsyncSync(fd);
    else this.dirty = true; // flushed by timer (everysec) or on close (no/everysec)
  }

  readAll(): Fact[] {
    if (!existsSync(this.path)) { this.entries = 0; return []; }
    const bytes = readFileSync(this.path);
    const out: Fact[] = [];
    let start = 0;
    let truncateAt: number | undefined;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      const line = bytes.subarray(start, end).toString("utf-8").trim();
      if (line) {
        try {
          out.push(JSON.parse(line) as Fact);
        } catch {
          // Only an unterminated LAST record can be a torn append. Silently
          // skipping a corrupt complete line would change the ordered history.
          if (newline !== -1) throw new Error(`corrupt journal record at byte ${start}`);
          truncateAt = start;
        }
      }
      start = end + 1;
    }
    if (truncateAt !== undefined || (bytes.length && bytes[bytes.length - 1] !== 10)) {
      // Repair before another append, using byte offsets (payloads may be UTF-8).
      // A complete final JSON record without a newline must be preserved.
      this.flush();
      if (truncateAt !== undefined) {
        truncateSync(this.path, truncateAt);
        this.recoveredTailBytes += bytes.length - truncateAt;
      } else {
        appendFileSync(this.path, "\n");
      }
      const repairFd = openSync(this.path, "r+");
      try { fsyncSync(repairFd); } finally { closeSync(repairFd); }
    }
    this.entries = out.length;
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
    this.entries = facts.length;
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
    return {
      entries: this.entries,
      bytes: statSync(this.path).size,
    };
  }
}
