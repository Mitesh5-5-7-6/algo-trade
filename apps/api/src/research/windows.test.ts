import { describe, expect, it } from "vitest";
import {
  calendarFingerprint,
  coverageOf,
  tradingDaysIn,
  windowComplete,
  windowOf,
  windowsBetween,
  windowSpan,
  type TradingCalendar,
} from "./windows.js";

/** Task 9.1 (design D1, D2): windows from a declared trading calendar, and where it and the data disagree. */
const NSE: TradingCalendar = {
  holidays: ["2026-01-26", "2026-03-03"],
  specialSessions: ["2026-02-01"],
  source: "test",
};

describe("window spans (9.1, D1)", () => {
  it("weeks are ISO 8601 — Monday to Sunday, in the year of their Thursday", () => {
    expect(windowSpan("WEEK", "2026-03-04")).toEqual({
      windowId: "2026-W10",
      fromDate: "2026-03-02",
      toDate: "2026-03-08",
    });
    expect(windowSpan("WEEK", "2026-01-01")).toEqual({
      windowId: "2026-W01",
      fromDate: "2025-12-29",
      toDate: "2026-01-04",
    });
    expect(windowSpan("WEEK", "2025-12-29").windowId).toBe("2026-W01");
    // 2026 starts on a Thursday, so it has 53 ISO weeks; 1 January 2027 is in the last.
    expect(windowSpan("WEEK", "2027-01-01")).toEqual({
      windowId: "2026-W53",
      fromDate: "2026-12-28",
      toDate: "2027-01-03",
    });
  });

  it("months and quarters are the calendar's", () => {
    expect(windowSpan("MONTH", "2026-02-14")).toEqual({
      windowId: "2026-02",
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
    });
    expect(windowSpan("MONTH", "2024-02-10").toDate).toBe("2024-02-29");
    expect(windowSpan("QUARTER", "2026-03-31")).toEqual({
      windowId: "2026-Q1",
      fromDate: "2026-01-01",
      toDate: "2026-03-31",
    });
    expect(windowSpan("QUARTER", "2025-10-01")).toEqual({
      windowId: "2025-Q4",
      fromDate: "2025-10-01",
      toDate: "2025-12-31",
    });
  });
});

describe("trading days in a window (9.1, D1, spec §5.5)", () => {
  it("a week holding a holiday is four trading days", () => {
    expect(windowOf("WEEK", "2026-03-04", NSE).tradingDays).toEqual([
      "2026-03-02",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
    ]);
  });

  /** 2026-W05: Republic Day on Monday, the Budget session on Sunday. */
  it("a special session belongs to its week, and a holiday does not", () => {
    expect(windowOf("WEEK", "2026-01-28", NSE).tradingDays).toEqual([
      "2026-01-27",
      "2026-01-28",
      "2026-01-29",
      "2026-01-30",
      "2026-02-01",
    ]);
  });

  it("with no calendar declared, every weekday is expected — and a holiday then shows up as a gap, not a short week", () => {
    const bare: TradingCalendar = {
      holidays: [],
      specialSessions: [],
      source: "none",
    };
    expect(tradingDaysIn("2026-03-02", "2026-03-08", bare)).toHaveLength(5);
  });

  it("covers a range with whole windows, in order, once each", () => {
    const months = windowsBetween("MONTH", "2025-09-29", "2026-09-28", NSE);
    expect(months.map((w) => w.windowId)).toEqual([
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(months[0]?.fromDate).toBe("2025-09-01"); // whole, not clipped to the range
    const weeks = windowsBetween("WEEK", "2025-09-29", "2026-09-28", NSE);
    expect(new Set(weeks.map((w) => w.windowId)).size).toBe(weeks.length);
    expect(weeks).toHaveLength(53);
    expect(
      windowsBetween("QUARTER", "2025-09-29", "2026-09-28", NSE).map(
        (w) => w.windowId,
      ),
    ).toEqual(["2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"]);
  });
});

describe("coverage — the calendar against the reports (9.1, D2)", () => {
  const week = windowOf("WEEK", "2026-03-04", NSE);

  it("is clean when every expected day is reported", () => {
    expect(
      coverageOf(week, [
        "2026-03-02",
        "2026-03-04",
        "2026-03-05",
        "2026-03-06",
      ]),
    ).toEqual({ expected: 4, reported: 4, gaps: [], unexpected: [] });
  });

  it("names a gap — an expected day with no report — rather than shrinking the week", () => {
    expect(
      coverageOf(week, ["2026-03-02", "2026-03-05", "2026-03-06"]),
    ).toEqual({
      expected: 4,
      reported: 3,
      gaps: ["2026-03-04"],
      unexpected: [],
    });
  });

  it("names a day reported that the calendar says was closed", () => {
    const c = coverageOf(week, [
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-09",
    ]);
    expect(c.unexpected).toEqual(["2026-03-03"]); // Holi, declared closed; 03-09 is outside the week
  });
});

describe("completeness and the calendar's fingerprint", () => {
  it("a window is complete once its last trading day has closed", () => {
    const week = windowOf("WEEK", "2026-03-04", NSE);
    expect(windowComplete(week, (d) => d <= "2026-03-05")).toBe(false);
    expect(windowComplete(week, (d) => d <= "2026-03-06")).toBe(true);
  });

  it("is the holiday and special-session lists, in any order — not their source label", () => {
    const a = calendarFingerprint(NSE);
    expect(
      calendarFingerprint({
        ...NSE,
        holidays: [...NSE.holidays].reverse(),
        source: "elsewhere",
      }),
    ).toBe(a);
    expect(calendarFingerprint({ ...NSE, holidays: ["2026-01-26"] })).not.toBe(
      a,
    );
  });
});
