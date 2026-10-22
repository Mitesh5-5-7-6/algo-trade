import { beforeAll, describe, expect, it } from "vitest";
import {
  intervalMs,
  istDateKey,
  TradeSchema,
  type Candle,
  type PatternOccurrence,
} from "@neelkanth/core";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL, regimeAt } from "../counterfactual/regime.js";
import { runDay, type DayRun } from "./day.js";
import { excursionOf, tradeEvidence } from "./evidence.js";

/** Task 8.2 (design D2): each Trade, entry to exit, and what came before it. */
const bar = (high: number, low: number): Candle => ({
  symbol: "NSE:X-EQ",
  interval: "5m",
  source: "BROKER_HISTORICAL",
  open: (high + low) / 2,
  high,
  low,
  close: (high + low) / 2,
  volume: 0,
  ts: 0,
});

describe("excursion (8.2, D2)", () => {
  /** Entry 100; highs 104 and 101, lows 99 and 98. */
  it("measures the best and worst move, per unit, in the Trade's own direction", () => {
    const held = [bar(104, 99), bar(101, 98)];
    expect(excursionOf("LONG", 100, held)).toEqual({
      favourable: 4,
      adverse: 2,
    });
    expect(excursionOf("SHORT", 100, held)).toEqual({
      favourable: 2,
      adverse: 4,
    });
  });
  it("is never negative, and nothing held is nothing moved", () => {
    expect(excursionOf("LONG", 100, [bar(99, 95)])).toEqual({
      favourable: 0,
      adverse: 5,
    });
    expect(excursionOf("SHORT", 100, [])).toEqual({
      favourable: 0,
      adverse: 0,
    });
  });
});

describe("trade evidence on a real day (8.2, D2)", () => {
  let day: DayRun;
  beforeAll(async () => {
    day = await runDay({
      date: "2026-01-14",
      candles: await historicalBars(
        [0, 1, 2, 3, 4, 7, 8, 9],
        (d) => 1 + (d % 5) * 0.04 + d * 0.01,
      ),
      symbols: ["NSE:TESTCO-EQ"],
      hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
      ...goldenBudget(),
      seed: 0,
      regime: { ...DEFAULT_REGIME_MODEL, symbol: "NSE:TESTINDEX-INDEX" },
    });
  }, 120_000);

  it("gives every Trade of the day its evidence, linked to the Signal that opened it", () => {
    const evidence = tradeEvidence(day);
    const trades = day.strategyDays.flatMap((s) => s.trades);
    expect(evidence.map((e) => e.tradeId).sort()).toEqual(
      trades.map((t) => t.tradeId).sort(),
    );
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      const run = day.evaluation.runs.find(
        (r) => r.strategyType === e.strategyType,
      );
      const signal = run?.trail.signals.find(
        (s) => s.signalId === e.entry.signalId,
      );
      expect(e.entry.reason).toBe(signal?.reason);
      expect(signal?.side).toBe(e.side === "LONG" ? "BUY" : "SELL");
      expect(istDateKey(e.entry.barTs)).toBe("2026-01-14");
    }
  });

  it("records the outcome and costs exactly as the Trade does", () => {
    // Keyed as the evidence is: Trade ids repeat across strategies.
    const trades = new Map(
      day.strategyDays.flatMap((s) =>
        s.trades.map(
          (t) => [[s.strategyType, t.symbol, t.tradeId].join("|"), t] as const,
        ),
      ),
    );
    const evidence = tradeEvidence(day);
    expect(new Set(evidence.map((e) => e.key)).size).toBe(evidence.length);
    for (const e of evidence) {
      const t = trades.get(e.key);
      expect(e.outcome.net).toBeCloseTo(t?.netPnl ?? NaN, 4);
      expect(e.outcome.charges).toBeCloseTo(t?.charges ?? NaN, 4);
      expect(e.outcome.result).toBe(
        (t?.netPnl ?? 0) > 0 ? "WIN" : (t?.netPnl ?? 0) < 0 ? "LOSS" : "FLAT",
      );
      expect(e.exit.reason).toBe(t?.exitReason);
      expect(e.held.bars).toBeGreaterThanOrEqual(0);
    }
  });

  /** Nothing after the entry bar, nothing from another session, nothing beyond N bars back. */
  it("says what came before the entry, and only what came before it", () => {
    const barMs = intervalMs("5m");
    let sawOne = false;
    for (const e of tradeEvidence(day, 6)) {
      expect(e.preceding.regime).toBe(
        regimeAt(day.evaluation.timeline, e.entry.barTs),
      );
      for (const p of e.preceding.patterns) {
        sawOne = true;
        expect(p.ts).toBeLessThanOrEqual(e.entry.barTs);
        expect(p.ts).toBeGreaterThanOrEqual(e.entry.barTs - 6 * barMs);
        expect(istDateKey(p.ts)).toBe(istDateKey(e.entry.barTs));
        expect(p.barsBeforeEntry).toBe(
          Math.round((e.entry.barTs - p.ts) / barMs),
        );
      }
      // Every occurrence in that span is there: the list is complete, not a sample.
      const expected = day.evaluation.occurrences.filter(
        (o) =>
          o.symbol === e.symbol &&
          o.ts <= e.entry.barTs &&
          o.ts >= e.entry.barTs - 6 * barMs &&
          istDateKey(o.ts) === istDateKey(e.entry.barTs),
      );
      expect(e.preceding.patterns).toHaveLength(expected.length);
    }
    expect(sawOne).toBe(true);
    // A shorter look-back sees no more.
    const wide = tradeEvidence(day, 6).reduce(
      (n, e) => n + e.preceding.patterns.length,
      0,
    );
    const narrow = tradeEvidence(day, 1).reduce(
      (n, e) => n + e.preceding.patterns.length,
      0,
    );
    expect(narrow).toBeLessThan(wide);
  });

  it("measures excursions on the bars after the entry bar, up to the exit", () => {
    for (const e of tradeEvidence(day)) {
      const held = day.bars.filter(
        (b) =>
          b.symbol === e.symbol &&
          b.ts > e.entry.barTs &&
          b.ts <= (e.exit.time ?? Infinity),
      );
      expect(e.held.bars).toBe(held.length);
      expect(e.excursion).toEqual(excursionOf(e.side, e.entry.price, held));
    }
  });
});

/**
 * The boundaries, placed exactly: occurrences one bar after the entry, seven
 * bars before it, in the previous session — all excluded — and six bars
 * before and on the entry bar — included.
 */
describe("what precedes an entry, at its boundaries (8.2, D2)", () => {
  it("includes exactly the entry bar and the N bars before it, in its session", async () => {
    const day = await runDay({
      date: "2026-01-06",
      candles: await historicalBars([0, 1]),
      symbols: ["NSE:TESTCO-EQ"],
      hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
      ...goldenBudget(),
      seed: 0,
      regime: { ...DEFAULT_REGIME_MODEL, symbol: "NSE:TESTINDEX-INDEX" },
    });
    const B = intervalMs("5m");
    const entryBar = Date.UTC(2026, 0, 6, 3, 45) + 30 * B;
    const at = (ts: number, patternId: string): PatternOccurrence => ({
      patternId,
      detectorVersion: "1.0.0",
      symbol: "NSE:TESTCO-EQ",
      interval: "5m",
      ts,
      direction: "BULLISH",
      evidence: {},
      params: {},
      marketContext: {},
      dataProvenance: {
        symbol: "NSE:TESTCO-EQ",
        interval: "5m",
        barTs: ts,
        source: "BROKER_HISTORICAL",
      },
    });
    const trade = TradeSchema.parse({
      tradeId: "trd_x",
      strategyId: "s",
      symbol: "NSE:TESTCO-EQ",
      side: "LONG",
      mode: "paper",
      entryOrderId: "o1",
      entryTime: entryBar + B,
      entryPrice: 100,
      quantity: 1,
      status: "CLOSED",
      exitTime: entryBar + 10 * B,
      exitPrice: 101,
      exitReason: "TAKE_PROFIT",
      grossPnl: 1,
      netPnl: 1,
      dataProvenance: {
        symbol: "NSE:TESTCO-EQ",
        interval: "5m",
        barTs: entryBar,
        source: "BROKER_HISTORICAL",
      },
      openedAt: entryBar + B,
    });
    const fixed: DayRun = {
      ...day,
      strategyDays: [
        {
          strategyType: "EMA_CROSSOVER",
          symbol: "NSE:TESTCO-EQ",
          signals: [],
          trades: [trade],
        },
      ],
      evaluation: {
        ...day.evaluation,
        occurrences: [
          at(entryBar + B, "AFTER"),
          at(entryBar - 7 * B, "TOO_EARLY"),
          at(entryBar - 86_400_000, "YESTERDAY"),
          at(entryBar - 6 * B, "SIX_BEFORE"),
          at(entryBar, "ON_ENTRY"),
        ],
      },
    };
    const [e] = tradeEvidence(fixed, 6);
    expect(
      e?.preceding.patterns.map((x) => [x.patternId, x.barsBeforeEntry]),
    ).toEqual([
      ["ON_ENTRY", 0],
      ["SIX_BEFORE", 6],
    ]);
  }, 120_000);
});
