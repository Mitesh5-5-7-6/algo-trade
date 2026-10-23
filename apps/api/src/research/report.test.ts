import { beforeAll, describe, expect, it } from "vitest";
import { istDateKey, type Candle } from "@neelkanth/core";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import { runDay, type DayRun } from "./day.js";
import {
  buildDailyReports,
  inputsFingerprint,
  isStale,
  reportIdOf,
} from "./report.js";

/** Task 8.5 (design D5): a report that says what it stood on, and is never edited. */
const SYM = "NSE:TESTCO-EQ";
let candles: Candle[];
let day: DayRun;
beforeAll(async () => {
  candles = await historicalBars(
    [0, 1, 2, 3, 4, 7, 8, 9],
    (d) => 1 + (d % 5) * 0.04 + d * 0.01,
  );
  day = await runDay({
    date: "2026-01-14",
    candles,
    symbols: [SYM],
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 0,
    regime: { ...DEFAULT_REGIME_MODEL, symbol: "NSE:TESTINDEX-INDEX" },
  });
}, 120_000);

describe("a daily report (8.5, D5)", () => {
  it("holds the day's features, patterns, strategies, Trade evidence and charts", () => {
    const [r] = buildDailyReports(day, 1_000);
    expect(r).toMatchObject({
      reportId: "DAY|2026-01-14|NSE:TESTCO-EQ|v1",
      period: "DAY",
      date: "2026-01-14",
      symbol: SYM,
      version: 1,
      dailyResearchVersion: "1",
    });
    expect(r?.features.symbol).toBe(SYM);
    expect(r?.patterns.length).toBeGreaterThan(0);
    expect(r?.strategies).toHaveLength(8);
    expect(r?.trades.length).toBeGreaterThan(0);
    expect(r?.charts.trades).toHaveLength(r?.trades.length ?? -1);
    expect(r?.charts.day.chartId).toBe("2026-01-14|NSE:TESTCO-EQ|day");
    expect(r?.models).toMatchObject({
      counterfactualVersion: "2",
      regime: { kind: "INDEX_TREND" },
      attribution: { windowBars: 0 },
    });
  });

  it("names every bar it read — the whole market's, not only its own symbol's", () => {
    const [r] = buildDailyReports(day, 1_000);
    expect(r?.inputs.bars.map((b) => b.symbol)).toEqual([
      "NSE:TESTCO-EQ",
      "NSE:TESTINDEX-INDEX",
    ]);
    expect(r?.inputs.bars.reduce((n, b) => n + b.count, 0)).toBe(
      day.bars.length,
    );
    expect(r?.inputs.fingerprint).toBe(inputsFingerprint(day.bars));
  });

  it("is fingerprinted by its content — not its id, version or when it was made", () => {
    const [a] = buildDailyReports(day, 1_000, 1);
    const [b] = buildDailyReports(day, 9_999, 2);
    expect(b?.fingerprint).toBe(a?.fingerprint);
    expect(b?.reportId).toBe(reportIdOf("2026-01-14", SYM, 2));
  });
});

describe("knowing when a report's inputs have changed (8.5, spec §5.8)", () => {
  const revise = (
    bars: Candle[],
    date: string,
    symbol: string,
    change: Partial<Candle>,
  ): Candle[] => {
    let done = false;
    return bars.map((b) => {
      if (done || b.symbol !== symbol || istDateKey(b.ts) !== date) return b;
      done = true;
      return { ...b, ...change };
    });
  };

  it("does not depend on the order the bars arrive in", () => {
    expect(inputsFingerprint([...day.bars].reverse())).toBe(
      inputsFingerprint(day.bars),
    );
  });

  it("is stale when any bar it read is revised — in any field, any symbol, any of its sessions", () => {
    const [r] = buildDailyReports(day, 1_000);
    if (r === undefined) throw new Error("no report");
    expect(isStale(r, candles)).toBe(false);
    expect(isStale(r, revise(candles, "2026-01-14", SYM, { close: 999 }))).toBe(
      true,
    );
    expect(
      isStale(
        r,
        revise(candles, "2026-01-08", SYM, { volumeQuality: "SUSPECT" }),
      ),
    ).toBe(true);
    expect(
      isStale(
        r,
        revise(candles, "2026-01-12", "NSE:TESTINDEX-INDEX", {
          ingestionVersion: 2,
        }),
      ),
    ).toBe(true);
    expect(
      isStale(r, revise(candles, "2026-01-13", SYM, { source: "LIVE_TICK" })),
    ).toBe(true);
    // A bar removed is a revision too.
    const gone = candles.filter(
      (c, i) =>
        !(c.symbol === SYM && istDateKey(c.ts) === "2026-01-14" && i % 7 === 0),
    );
    expect(isStale(r, gone)).toBe(true);
  });

  /** Exactly the reports that read it: a change outside its window is not its business. */
  it("is not stale for a change on a day it did not read", () => {
    const [r] = buildDailyReports(day, 1_000);
    if (r === undefined) throw new Error("no report");
    expect(isStale(r, revise(candles, "2026-01-07", SYM, { close: 999 }))).toBe(
      false,
    ); // before its 5 sessions
    expect(isStale(r, revise(candles, "2026-01-15", SYM, { close: 999 }))).toBe(
      false,
    ); // after its day
  });
});
