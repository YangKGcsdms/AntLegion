/**
 * scheduler tests (计划 13 §四): cron parsing + deterministic fire slots.
 * 调度不是旁路，是事实 — these folds decide WHICH facts, so they must be exact.
 */
import { describe, expect, it } from "vitest";
import { cronMatches, dueSlots, parseCron, slotKey } from "../src/dcus/scheduler-dcu.js";

const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi);

describe("parseCron", () => {
  it("parses the daily-9am shape from the plan", () => {
    const c = parseCron("0 9 * * *");
    expect(c.min.has(0)).toBe(true);
    expect(c.min.size).toBe(1);
    expect(c.hour.has(9)).toBe(true);
    expect(c.dom.size).toBe(31);
    expect(c.dow.size).toBe(7);
  });
  it("steps, ranges, lists", () => {
    const c = parseCron("*/15 8-10 1,15 * 1-5");
    expect([...c.min]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toEqual([8, 9, 10]);
    expect([...c.dom]).toEqual([1, 15]);
    expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
  });
  it("rejects malformed fields", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("x * * * *")).toThrow(/bad cron field/);
  });
});

describe("cronMatches", () => {
  it("matches minute+hour+dow together", () => {
    const c = parseCron("30 14 * * 4"); // Thu 14:30 — 2026-08-13 is a Thursday
    expect(cronMatches(c, at(2026, 8, 13, 14, 30))).toBe(true);
    expect(cronMatches(c, at(2026, 8, 13, 14, 31))).toBe(false);
    expect(cronMatches(c, at(2026, 8, 14, 14, 30))).toBe(false); // Friday
  });
});

describe("slotKey", () => {
  it("is minute-resolution local time — the nonce's determinism anchor", () => {
    expect(slotKey(at(2026, 8, 13, 9, 0))).toBe("2026-08-13T09:00");
  });
});

describe("dueSlots", () => {
  const daily9 = parseCron("0 9 * * *");

  it("steady state: fires exactly the slots between checks", () => {
    const last = at(2026, 8, 13, 8, 58).getTime();
    const now = at(2026, 8, 13, 9, 1).getTime();
    const slots = dueSlots(daily9, last, now);
    expect(slots.map(slotKey)).toEqual(["2026-08-13T09:00"]);
  });

  it("no double fire when the window has no matching slot", () => {
    const last = at(2026, 8, 13, 9, 1).getTime();
    const now = at(2026, 8, 13, 9, 4).getTime();
    expect(dueSlots(daily9, last, now)).toEqual([]);
  });

  it("cold boot after the slot: 补发当日 — the latest missed slot fires", () => {
    const now = at(2026, 8, 13, 11, 30).getTime(); // slept through 09:00
    const slots = dueSlots(daily9, null, now);
    expect(slots.map(slotKey)).toEqual(["2026-08-13T09:00"]);
  });

  it("cold boot before the slot: nothing fires early", () => {
    const now = at(2026, 8, 13, 7, 0).getTime();
    expect(dueSlots(daily9, null, now)).toEqual([]);
  });

  it("cold boot: only TODAY is made up — yesterday's slots stay skipped", () => {
    const every6h = parseCron("0 */6 * * *");
    const now = at(2026, 8, 13, 0, 30).getTime();
    // yesterday had 00/06/12/18 — none fire; today's 00:00 does
    expect(dueSlots(every6h, null, now).map(slotKey)).toEqual(["2026-08-13T00:00"]);
  });

  it("a long sleep within the day catches every slot on wake (dedup handles restarts)", () => {
    const hourly = parseCron("0 * * * *");
    const last = at(2026, 8, 13, 8, 30).getTime();
    const now = at(2026, 8, 13, 11, 10).getTime();
    expect(dueSlots(hourly, last, now).map(slotKey))
      .toEqual(["2026-08-13T09:00", "2026-08-13T10:00", "2026-08-13T11:00"]);
  });
});
