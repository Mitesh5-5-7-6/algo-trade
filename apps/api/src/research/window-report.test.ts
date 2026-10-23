import { describe, expect, it } from "vitest";
import type { TradeEvidence } from "./evidence.js";
import type { PatternObservation } from "./observations.js";
import {
  buildWindowReport,
  isWindowStale,
  type DailyRef,
} from "./window-report.js";
import { windowOf, type TradingCalendar } from "./windows.js";

/** Task 9.4 (design D5): a window report that says what it read, and knows when that changed. */
const CAL: TradingCalendar = {
  holidays: ["2026-03-03"],
  specialSessions: [],
  source: "test",
};
const A = "NSE:A-INDEX";
const B = "NSE:B-INDEX";
const ev = (net: number): TradeEvidence => ({
  key: `ORB|${A}|trd_1`,
  tradeId: "trd_1",
  strategyType: "ORB",
  symbol: A,
  side: "LONG",
  quantity: 1,
  entry: { signalId: "s", barTs: 0, time: 0, price: 100, reason: null },
  exit: { time: 1, price: 100 + net, reason: "TAKE_PROFIT" },
  outcome: {
    result: net > 0 ? "WIN" : "LOSS",
    gross: net,
    charges: 0,
    slippage: 0,
    net,
    netPerUnit: net,
  },
  held: { bars: 1, minutes: 5 },
  excursion: { favourable: 1, adverse: 1 },
  preceding: { regime: "BULLISH", patterns: [] },
});
const obs = (key: string): PatternObservation => ({
  patternId: "ORB_BREAKOUT",
  detectorVersion: "1.0.0",
  ts: 0,
  direction: "BULLISH",
  evidence: {},
  marketContext: {},
  regime: "BULLISH",
  strategies: { ORB: { relation: "ENTERED", tradeKey: key } },
});
const daily = (
  date: string,
  symbol: string,
  version = 1,
  net = 5,
): DailyRef => {
  const e = { ...ev(net), symbol, key: `ORB|${symbol}|trd_1` };
  return {
    reportId: `DAY|${date}|${symbol}|v${String(version)}`,
    fingerprint: `${date}${symbol}${String(version)}`
      .padEnd(64, "0")
      .slice(0, 64),
    report: { date, symbol, patterns: [obs(e.key)], trades: [e] },
  };
};
const week = windowOf("WEEK", "2026-03-04", CAL); // 03-02, 03-04, 03-05, 03-06
const full = [
  ...week.tradingDays.map((d) => daily(d, A)),
  ...week.tradingDays.map((d) => daily(d, B)),
];

describe("a window report (9.4, D5)", () => {
  it("aggregates the window's daily reports, and answers its period's questions", () => {
    const r = buildWindowReport(week, CAL, [A, B], full, 1_000);
    expect(r).toMatchObject({
      reportId: "WEEK|2026-W10|ALL|v1",
      period: "WEEK",
      windowId: "2026-W10",
      fromDate: "2026-03-02",
      toDate: "2026-03-08",
      symbol: "ALL",
      periodicResearchVersion: "1",
    });
    expect(r.aggregate.days).toEqual(week.tradingDays);
    expect(r.aggregate.instruments).toEqual([A, B]);
    expect(r.answers).toHaveProperty("recurred");
    expect(r.calendar).toMatchObject({
      source: "test",
      tradingDays: week.tradingDays,
    });
  });

  it("states coverage per instrument — a gap on one is named, the other is clean", () => {
    const missing = full.filter(
      (d) => !(d.report.symbol === B && d.report.date === "2026-03-05"),
    );
    const r = buildWindowReport(week, CAL, [A, B], missing, 1_000);
    expect(r.coverage[A]).toEqual({
      expected: 4,
      reported: 4,
      gaps: [],
      unexpected: [],
    });
    expect(r.coverage[B]).toEqual({
      expected: 4,
      reported: 3,
      gaps: ["2026-03-05"],
      unexpected: [],
    });
  });

  it("reads only its own span and instruments", () => {
    const extra = [
      ...full,
      daily("2026-03-09", A),
      daily("2026-03-04", "NSE:C-INDEX"),
    ];
    const r = buildWindowReport(week, CAL, [A, B], extra, 1_000);
    expect(r.inputs.reports).toHaveLength(8);
    expect(r.fingerprint).toBe(
      buildWindowReport(week, CAL, [A, B], full, 9_999, 2).fingerprint,
    );
  });

  it("names every daily report it read, by id and fingerprint", () => {
    const r = buildWindowReport(week, CAL, [A, B], full, 1_000);
    expect(r.inputs.reports.map((x) => x.reportId)).toEqual(
      full.map((d) => d.reportId).sort(),
    );
  });

  it("answers a quarter month by month", () => {
    const quarter = windowOf("QUARTER", "2026-03-04", CAL);
    const r = buildWindowReport(
      quarter,
      CAL,
      [A],
      [daily("2026-01-05", A), daily("2026-02-02", A), daily("2026-03-02", A)],
      1_000,
    );
    expect(r.answers).toHaveProperty("pairs");
    const pair = (
      r.answers as { pairs: { byMonth: Record<string, unknown> }[] }
    ).pairs[0];
    expect(Object.keys(pair?.byMonth ?? {})).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });
});

describe("knowing when a window must be recomputed (9.4, D5)", () => {
  const r = buildWindowReport(week, CAL, [A, B], full, 1_000);

  it("stands while its daily reports do", () => {
    expect(isWindowStale(r, full)).toBe(false);
    expect(isWindowStale(r, [...full].reverse())).toBe(false);
  });

  it("is stale when one of its daily reports is superseded by a new version", () => {
    const revised = full.map((d) =>
      d.report.date === "2026-03-04" && d.report.symbol === A
        ? daily("2026-03-04", A, 2, -9)
        : d,
    );
    expect(isWindowStale(r, revised)).toBe(true);
  });

  /** A gap later filled is new evidence for the window. */
  it("is stale when a report arrives for one of its gaps", () => {
    const partial = buildWindowReport(week, CAL, [A, B], full.slice(1), 1_000);
    expect(isWindowStale(partial, full)).toBe(true);
  });

  it("is not stale for a change outside its span or instruments", () => {
    expect(
      isWindowStale(r, [
        ...full,
        daily("2026-03-09", A, 2),
        daily("2026-03-04", "NSE:C-INDEX", 2),
      ]),
    ).toBe(false);
  });
});
