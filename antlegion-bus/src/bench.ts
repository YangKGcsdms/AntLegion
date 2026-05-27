/**
 * antlegion-bench — the redis-benchmark analog.
 *
 * Measures raw append + full-scan read throughput of the core (in-process, no
 * HTTP), to confirm the bus is fast enough to be treated as infrastructure.
 *
 *   ANTLEGION_BENCH_N=50000 ANTLEGION_FSYNC=no tsx src/bench.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BusV2 } from "./bus.js";
import type { FsyncPolicy } from "./log.js";

export interface BenchResult {
  n: number;
  fsync: FsyncPolicy;
  appendPerSec: number;
  readPerSec: number;
}

export function runBench(opts: { n?: number; fsync?: FsyncPolicy; dataDir?: string } = {}): BenchResult {
  const n = opts.n ?? 20000;
  const fsync = opts.fsync ?? "no";
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "antlegion-v2-bench-"));
  const bus = new BusV2({ secret: "bench", dataDir, fsync });

  const a0 = performance.now();
  for (let i = 0; i < n; i++) {
    bus.append({ type: "bench.fact", author: "bench", ts: i, payload: { i }, nonce: String(i) });
  }
  const a1 = performance.now();

  const rounds = 5;
  const r0 = performance.now();
  for (let k = 0; k < rounds; k++) bus.read({ since: 0, limit: n });
  const r1 = performance.now();

  bus.close();
  return {
    n,
    fsync,
    appendPerSec: Math.round(n / ((a1 - a0) / 1000)),
    readPerSec: Math.round((n * rounds) / ((r1 - r0) / 1000)),
  };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = process.env.ANTLEGION_BENCH_N ? parseInt(process.env.ANTLEGION_BENCH_N, 10) : 20000;
  const fsync = (process.env.ANTLEGION_FSYNC as FsyncPolicy) ?? "no";
  const r = runBench({ n, fsync });
  console.log(`antlegion-bench  n=${r.n}  fsync=${r.fsync}`);
  console.log(`  append: ${r.appendPerSec.toLocaleString()} ops/s`);
  console.log(`  read  : ${r.readPerSec.toLocaleString()} scans*facts/s`);
}
