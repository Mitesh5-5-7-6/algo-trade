import { describe, expect, it } from "vitest";
import { istDayStart, NSE_DEFAULT_SESSION, type Candle } from "@neelkanth/core";
import { buildPool } from "./pool.js";

const SYMBOL = "NSE:NIFTY50-INDEX";
const OPEN_MINUTE = 9 * 60 + 15;

/** `count` five-minute bars of one IST date, from the 09:15 bell. */
function session(
  date: string,
  count = 75,
  firstMinute = OPEN_MINUTE,
): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: SYMBOL,
    interval: "5m" as const,
    ts: istDayStart(date) + (firstMinute + 5 * i) * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 0,
    source: "BROKER_HISTORICAL" as const,
  }));
}

describe("the setup-odds pool (17.2)", () => {
  it("holds only sessions strictly before the plan's date", () => {
    const pool = buildPool(
      [
        ...session("2026-03-02"),
        ...session("2026-03-03"),
        ...session("2026-03-04"),
        ...session("2026-03-05"),
      ],
      { planDate: "2026-03-04" },
    );
    expect(pool.sessions.map((s) => s.date)).toEqual([
      "2026-03-02",
      "2026-03-03",
    ]);
  });

  it("counts the bars of a full session from the session's own hours", () => {
    const bars = [...session("2026-03-02"), ...session("2026-03-03")];
    expect(buildPool(bars, { planDate: "2026-03-04" }).barsPerSession).toBe(75);

    // An exchange that opened at 10:00 would have 66 five-minute bars, and
    // the 09:15 sessions above would then be the wrong shape for it.
    const later = buildPool(bars, {
      planDate: "2026-03-04",
      session: { ...NSE_DEFAULT_SESSION, open: "10:00" },
    });
    expect(later.barsPerSession).toBe(66);
    expect(later.sessions).toEqual([]);
  });

  it("leaves out a weekend session and lists it", () => {
    // 2026-02-01 is the Budget Sunday: a real session, not a regular one.
    const pool = buildPool(
      [...session("2026-01-30"), ...session("2026-02-01")],
      { planDate: "2026-02-02" },
    );
    expect(pool.sessions.map((s) => s.date)).toEqual(["2026-01-30"]);
    expect(pool.excluded).toEqual([
      { date: "2026-02-01", reason: "SPECIAL_SESSION", bars: 75 },
    ]);
  });

  it("leaves out a weekday the calendar declares special", () => {
    const pool = buildPool(
      [...session("2026-03-02"), ...session("2026-03-03")],
      {
        planDate: "2026-03-04",
        session: { ...NSE_DEFAULT_SESSION, specialSessions: ["2026-03-03"] },
      },
    );
    expect(pool.sessions.map((s) => s.date)).toEqual(["2026-03-02"]);
    expect(pool.excluded).toEqual([
      { date: "2026-03-03", reason: "SPECIAL_SESSION", bars: 75 },
    ]);
  });

  it("leaves out a short session and lists it", () => {
    const pool = buildPool(
      [...session("2026-03-02"), ...session("2026-03-03", 74)],
      { planDate: "2026-03-04" },
    );
    expect(pool.sessions.map((s) => s.date)).toEqual(["2026-03-02"]);
    expect(pool.excluded).toEqual([
      { date: "2026-03-03", reason: "INCOMPLETE", bars: 74 },
    ]);
  });

  it("leaves out a session whose 75 bars are not the 09:15 grid", () => {
    // 75 bars, but starting five minutes early: the right count, the wrong
    // slots — bar 10 of this day is not 10:05, so it cannot stand in for it.
    const shifted = session("2026-03-03", 75, OPEN_MINUTE - 5);
    const pool = buildPool([...session("2026-03-02"), ...shifted], {
      planDate: "2026-03-04",
    });
    expect(pool.sessions.map((s) => s.date)).toEqual(["2026-03-02"]);
    expect(pool.excluded).toEqual([
      { date: "2026-03-03", reason: "INCOMPLETE", bars: 75 },
    ]);
  });

  it("hands back each session's bars in time order, whatever order they came in", () => {
    const pool = buildPool([...session("2026-03-02")].reverse(), {
      planDate: "2026-03-04",
    });
    const stamps = pool.sessions[0]?.bars.map((b) => b.ts) ?? [];
    expect(stamps).toHaveLength(75);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });
});
