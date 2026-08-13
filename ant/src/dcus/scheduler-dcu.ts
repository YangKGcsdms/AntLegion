/**
 * dcus/scheduler-dcu.ts — cron 无人值守, AntLegion 本位 (计划 13 §四).
 *
 * A schedule is not a side-channel: on every beat the scheduler PUBLISHES A
 * FACT, and the work flows through the normal claim path. The schedule
 * itself lands on the chain — auditable like everything else.
 *
 * Determinism: each fire slot gets nonce `sched:{colony}:{name}:{slot}` and
 * ts = the slot's epoch — identical content on every retry/restart, so the
 * bus dedups and a restart can never double-fire. Missed-fire semantics:
 * catch up the CURRENT DAY's latest missed slot per schedule (a laptop that
 * slept through 09:00 fires on wake), skip anything older.
 */

import { httpTransport } from "@antlegion/bus/client";
import type { DCUSpec } from "../runtime.js";
import { colonyAuthor, type IdentityConfig, type ScheduleEntry } from "../config.js";
import { publishRegistry } from "./devchain-dcus.js";

export const SCHEDULER_AUTHOR = "dcu-scheduler@devchain";

export interface CronSpec {
  min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>;
}

/** Five-field cron: numbers, wildcard, steps (slash-n), ranges (`1-5`), lists (`1,3`). */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields, got "${expr}"`);
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const parsed = fields.map((f, i) => {
    const [lo, hi] = ranges[i]!;
    const out = new Set<number>();
    for (const part of f.split(",")) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!m) throw new Error(`bad cron field "${part}" in "${expr}"`);
      const step = m[2] ? parseInt(m[2], 10) : 1;
      let from = lo, to = hi;
      if (m[1] !== "*") {
        const [a, b] = m[1]!.split("-").map((n) => parseInt(n, 10));
        from = a!; to = b ?? a!;
      }
      if (from < lo || to > hi || from > to || step < 1) throw new Error(`cron field out of range: "${part}" in "${expr}"`);
      for (let v = from; v <= to; v += step) out.add(v);
    }
    return out;
  });
  return { min: parsed[0]!, hour: parsed[1]!, dom: parsed[2]!, mon: parsed[3]!, dow: parsed[4]! };
}

export function cronMatches(spec: CronSpec, d: Date): boolean {
  return spec.min.has(d.getMinutes()) && spec.hour.has(d.getHours())
    && spec.dom.has(d.getDate()) && spec.mon.has(d.getMonth() + 1)
    && spec.dow.has(d.getDay());
}

/** Local-time slot key, minute resolution: 2026-08-13T09:00 (part of the nonce). */
export function slotKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const floorMinute = (t: number): number => Math.floor(t / 60_000) * 60_000;
const startOfDay = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * All slots due in (lastChecked, now] — plus, when lastChecked is null (cold
 * boot), the latest matching slot earlier today: 补发当日，跳过更早.
 */
export function dueSlots(spec: CronSpec, lastCheckedMs: number | null, nowMs: number): Date[] {
  const nowSlot = floorMinute(nowMs);
  if (lastCheckedMs === null) {
    for (let t = nowSlot; t >= startOfDay(nowMs); t -= 60_000) {
      const d = new Date(t);
      if (cronMatches(spec, d)) return [d]; // latest missed slot today only
    }
    return [];
  }
  const out: Date[] = [];
  for (let t = floorMinute(lastCheckedMs) + 60_000; t <= nowSlot; t += 60_000) {
    const d = new Date(t);
    if (cronMatches(spec, d)) out.push(d);
  }
  return out;
}

export function schedulerDCU(
  busUrl: string, schedules: ScheduleEntry[], identity?: IdentityConfig,
): DCUSpec {
  const author = colonyAuthor(SCHEDULER_AUTHOR, identity?.colony);
  const colony = identity?.colony ?? "devchain";
  const specs = schedules.map((s) => ({ entry: s, cron: parseCron(s.cron) }));
  let lastChecked: number | null = null;
  return {
    name: author,
    author,
    busUrl,
    pollMs: 5000, // minute resolution — no need to race anyone
    init: async (ctx) => {
      await publishRegistry(busUrl, author, null, {
        role: "scheduler",
        listens: [],
        produces: [...new Set(schedules.map((s) => s.type))],
        schedules: schedules.map((s) => ({ name: s.name, cron: s.cron, type: s.type })),
      }, ctx.log, identity);
    },
    onBatch: async (_batch, ctx) => {
      const now = Date.now();
      for (const { entry, cron } of specs) {
        for (const slot of dueSlots(cron, lastChecked, now)) {
          const key = slotKey(slot);
          // Deterministic content: ts = slot epoch, stable nonce → restarts dedup.
          const r = await httpTransport(busUrl).append({
            type: entry.type,
            author,
            ts: Math.floor(slot.getTime() / 1000),
            payload: { ...(entry.payload ?? {}), schedule: entry.name, scheduled_for: key },
            nonce: `sched:${colony}:${entry.name}:${key}`,
          });
          ctx.log(`schedule ${entry.name} @ ${key} → ${entry.type} ${r.deduped ? "(deduped)" : `(seq ${r.seq})`}`);
        }
      }
      lastChecked = now;
    },
  };
}
