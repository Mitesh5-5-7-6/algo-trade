import { describe, expect, it } from "vitest";
import {
  SignalSchema,
  TradeSchema,
  type Candle,
  type PatternOccurrence,
  type Signal,
  type Trade,
} from "@neelkanth/core";
import { attribute, type StrategyRun } from "./attribution.js";
import { ALL, buildMatrix, tradeStats, type MatrixRow } from "./matrix.js";
import { DEFAULT_REGIME_MODEL, regimeTimeline } from "./regime.js";

/**
 * Task 6.4 (design D5, D6): which strategy did what about each occurrence,
 * and what the Trades it entered earned — n on every row.
 */
const SYM = "NSE:X-EQ";
const DAY = Date.UTC(2026, 0, 5, 3, 45); // Mon 09:15 IST
const NEXT_DAY = Date.UTC(2026, 0, 6, 3, 45);
const BAR = 300_000;
const bar = (k: number, day = DAY): number => day + k * BAR;

/** A rising regime index from bar 0: NEUTRAL until bar 20, then BULLISH. */
const timeline = regimeTimeline(
  Array.from({ length: 75 }, (_, k): Candle => ({
    symbol: DEFAULT_REGIME_MODEL.symbol,
    interval: "5m",
    source: "BROKER_HISTORICAL",
    open: 100 + k,
    high: 101 + k,
    low: 99 + k,
    close: 100 + k,
    volume: 0,
    ts: bar(k),
  })),
);

const occurrence = (
  k: number,
  patternId = "ORB_BREAKOUT",
  day = DAY,
): PatternOccurrence => ({
  patternId,
  detectorVersion: "1.0.0",
  symbol: SYM,
  interval: "5m",
  ts: bar(k, day),
  direction: "BULLISH",
  evidence: {},
  params: {},
  dataProvenance: {
    symbol: SYM,
    interval: "5m",
    barTs: bar(k, day),
    source: "BROKER_HISTORICAL",
  },
  marketContext: {},
});

let seq = 0;
function trade(
  entryBar: number,
  exitMinutes: number,
  net: number,
  over: Partial<Trade> = {},
): Trade {
  seq += 1;
  return TradeSchema.parse({
    tradeId: `trd_${String(seq)}`,
    strategyId: "str_a",
    symbol: SYM,
    side: "LONG",
    mode: "paper",
    entryOrderId: `ord_${String(seq)}`,
    entryTime: entryBar + BAR,
    entryPrice: 100,
    quantity: 10,
    exitTime: entryBar + BAR + exitMinutes * 60_000,
    exitPrice: 100 + net / 10,
    exitReason: "TAKE_PROFIT",
    status: "CLOSED",
    grossPnl: net + 2,
    charges: 2,
    slippage: 0.5,
    netPnl: net,
    dataProvenance: {
      symbol: SYM,
      interval: "5m",
      barTs: entryBar,
      source: "BROKER_HISTORICAL",
    },
    openedAt: entryBar + BAR,
    ...over,
  });
}
function entrySignal(barTs: number): Signal {
  seq += 1;
  return SignalSchema.parse({
    signalId: `sig_${String(seq)}`,
    strategyId: "str_a",
    symbol: SYM,
    side: "BUY",
    confidence: 0.6,
    reason: "test",
    contextSnapshot: {
      price: 100,
      indicators: {},
      session: "open",
      sentiment: 0,
    },
    dataProvenance: {
      symbol: SYM,
      interval: "5m",
      barTs,
      source: "BROKER_HISTORICAL",
    },
    ts: barTs + BAR,
  });
}
const run = (
  strategyType: string,
  trades: Trade[],
  signals: Signal[] = [],
): StrategyRun => ({
  strategyType,
  symbol: SYM,
  trail: { trades, signals, riskLogs: [] },
});
const relationOf = (occ: PatternOccurrence, r: StrategyRun, windowBars = 0) =>
  attribute([occ], [r], timeline, "5m", { version: "1", windowBars })[0]
    ?.relation;

describe("attribution (6.4, D5)", () => {
  it("ENTERED: a Trade decided on the pattern's bar", () => {
    expect(relationOf(occurrence(30), run("A", [trade(bar(30), 20, 5)]))).toBe(
      "ENTERED",
    );
  });

  it("only inside the declared window, and only forward", () => {
    const next = run("A", [trade(bar(31), 20, 5)]);
    expect(relationOf(occurrence(30), next, 0)).toBe("FLAT");
    expect(relationOf(occurrence(30), next, 1)).toBe("ENTERED");
    // A Trade decided a bar BEFORE the pattern is never its response.
    const before = run("A", [trade(bar(29), 0, 5)]);
    expect(relationOf(occurrence(30), before, 5)).toBe("FLAT");
  });

  it("never reaches into the next session", () => {
    const tomorrow = run("A", [trade(bar(0, NEXT_DAY), 20, 5)]);
    // A window wide enough to reach tomorrow's open still stops at the close.
    expect(relationOf(occurrence(74), tomorrow, 400)).toBe("FLAT");
  });

  it("SIGNALLED: an entry proposed in the window that opened no Trade", () => {
    expect(
      relationOf(occurrence(30), run("A", [], [entrySignal(bar(30))])),
    ).toBe("SIGNALLED");
  });

  it("HOLDING: already in a Trade open across the pattern's bar", () => {
    expect(relationOf(occurrence(30), run("A", [trade(bar(25), 60, 5)]))).toBe(
      "HOLDING",
    );
    // Exited before the pattern: not holding.
    expect(relationOf(occurrence(30), run("A", [trade(bar(20), 10, 5)]))).toBe(
      "FLAT",
    );
  });

  it("ENTERED outranks HOLDING; a strategy on another symbol is not asked", () => {
    const both = run("A", [trade(bar(25), 60, 5), trade(bar(30), 20, 5)]);
    expect(relationOf(occurrence(30), both)).toBe("ENTERED");
    const elsewhere = {
      ...run("A", [trade(bar(30), 20, 5)]),
      symbol: "NSE:Y-EQ",
    };
    expect(attribute([occurrence(30)], [elsewhere], timeline, "5m")).toEqual(
      [],
    );
  });

  it("labels each occurrence with the regime at its bar", () => {
    const [early, late] = attribute(
      [occurrence(5), occurrence(40)],
      [run("A", [])],
      timeline,
      "5m",
    );
    expect([early?.regime, late?.regime]).toEqual(["NEUTRAL", "BULLISH"]);
  });
});

describe("trade statistics (6.4, D6)", () => {
  it("counts, sums and rates, with n always", () => {
    const s = tradeStats([
      trade(bar(1), 10, 30),
      trade(bar(2), 20, -10),
      trade(bar(3), 30, 0),
    ]);
    expect(s).toMatchObject({
      n: 3,
      wins: 1,
      losses: 1,
      winRate: 0.3333,
      gross: 26,
      charges: 6,
      slippage: 1.5,
      net: 20,
      expectancy: 6.6667,
      expectancyPerUnit: 0.6667,
      meanHoldMinutes: 20,
      exits: { TAKE_PROFIT: 3 },
    });
  });

  /**
   * The first Trade entered is the last to exit. In exit order the
   * cumulative net runs 30 → 20 → -20, a fall of 50; in entry order it would
   * be -40 → -10 → -20, a fall of 40. Realised money is counted when it is
   * realised.
   */
  it("measures drawdown over the Trades in exit order", () => {
    const s = tradeStats([
      trade(bar(1), 300, -40),
      trade(bar(2), 5, 30),
      trade(bar(3), 10, -10),
    ]);
    expect(s.maxDrawdown).toBe(50);
  });

  /**
   * Phase 7 D2: an expectancy cannot be given an interval without the spread
   * of the Trades behind it. Nets 30, −10, 0: mean 6.667, sample sd 20.817.
   */
  it("carries the spread of net per Trade and per unit", () => {
    const s = tradeStats([
      trade(bar(1), 10, 30),
      trade(bar(2), 20, -10),
      trade(bar(3), 30, 0),
    ]);
    expect(s.netStdDev).toBeCloseTo(20.8167, 4);
    expect(s.perUnitStdDev).toBeCloseTo(2.0817, 4);
    // One Trade has no spread to speak of: null, not zero.
    expect(tradeStats([trade(bar(1), 10, 30)])).toMatchObject({
      netStdDev: null,
      perUnitStdDev: null,
    });
  });

  it("claims no rate it has no Trades for", () => {
    expect(tradeStats([])).toMatchObject({
      n: 0,
      winRate: null,
      expectancy: null,
      meanHoldMinutes: null,
      maxDrawdown: 0,
    });
  });
});

describe("the matrix (6.4, D6)", () => {
  const rowsFor = (
    rows: MatrixRow[],
    patternId: string,
    regime = ALL,
    symbol = ALL,
  ) =>
    rows.filter(
      (r) =>
        r.patternId === patternId && r.regime === regime && r.symbol === symbol,
    );

  it("has a row per pattern and strategy, with relations and the entered Trades", () => {
    const a = run("A", [trade(bar(30), 20, 10)]);
    const b = run("B", [], [entrySignal(bar(30))]);
    const occ = [occurrence(30), occurrence(45)];
    const rows = buildMatrix(
      attribute(occ, [a, b], timeline, "5m"),
      [a, b],
      timeline,
    );
    const orb = rowsFor(rows, "ORB_BREAKOUT");
    expect(
      orb.map((r) => [r.strategyType, r.occurrences, r.relations, r.trades.n]),
    ).toEqual([
      ["A", 2, { ENTERED: 1, SIGNALLED: 0, HOLDING: 0, FLAT: 1 }, 1],
      ["B", 2, { ENTERED: 0, SIGNALLED: 1, HOLDING: 0, FLAT: 1 }, 0],
    ]);
  });

  /** Two occurrences, one response: the Trade is evidence once. */
  it("counts a Trade once per row, however many occurrences point at it", () => {
    const a = run("A", [trade(bar(31), 20, 10)]);
    const occ = [occurrence(30), occurrence(31)];
    const rows = buildMatrix(
      attribute(occ, [a], timeline, "5m", { version: "1", windowBars: 1 }),
      [a],
      timeline,
    );
    const [row] = rowsFor(rows, "ORB_BREAKOUT");
    expect(row?.relations?.ENTERED).toBe(2);
    expect(row?.trades.n).toBe(1);
  });

  it("gives every strategy a baseline — all its Trades, regardless of pattern — even with none", () => {
    const a = run("A", [trade(bar(10), 20, 10), trade(bar(50), 20, -4)]);
    const silent = run("S", []);
    const rows = buildMatrix(
      attribute([occurrence(50)], [a, silent], timeline, "5m"),
      [a, silent],
      timeline,
    );
    const base = rowsFor(rows, ALL);
    expect(
      base.map((r) => [r.strategyType, r.trades.n, r.occurrences, r.relations]),
    ).toEqual([
      ["A", 2, null, null],
      ["S", 0, null, null],
    ]);
    // Split by the regime at each Trade's entry bar.
    expect(rowsFor(rows, ALL, "NEUTRAL").map((r) => r.trades.n)).toEqual([1]);
    expect(rowsFor(rows, ALL, "BULLISH").map((r) => r.trades.n)).toEqual([1]);
  });

  it("splits by regime and by symbol, and pools both as ALL", () => {
    const a = run("A", [trade(bar(5), 10, 1), trade(bar(40), 10, 2)]);
    const rows = buildMatrix(
      attribute([occurrence(5), occurrence(40)], [a], timeline, "5m"),
      [a],
      timeline,
    );
    expect(rowsFor(rows, "ORB_BREAKOUT", "NEUTRAL")[0]?.trades.net).toBe(1);
    expect(rowsFor(rows, "ORB_BREAKOUT", "BULLISH")[0]?.trades.net).toBe(2);
    expect(rowsFor(rows, "ORB_BREAKOUT", ALL)[0]?.trades.net).toBe(3);
    expect(rowsFor(rows, "ORB_BREAKOUT", ALL, SYM)[0]?.trades.net).toBe(3);
  });

  /**
   * Each symbol's replay numbers its Trades from one, so two symbols' runs of
   * one strategy share Trade ids. Found by the 6.8 acceptance run: keyed by
   * id alone, one symbol's Trades overwrote the other's.
   */
  it("keeps two symbols' Trades apart though their replays share Trade ids", () => {
    const OTHER = "NSE:Y-EQ";
    const onX = trade(bar(30), 20, 10, { tradeId: "trd_1" });
    const onY = trade(bar(30), 20, -4, {
      tradeId: "trd_1",
      symbol: OTHER,
      dataProvenance: {
        symbol: OTHER,
        interval: "5m",
        barTs: bar(30),
        source: "BROKER_HISTORICAL",
      },
    });
    const runs: StrategyRun[] = [
      run("A", [onX]),
      {
        strategyType: "A",
        symbol: OTHER,
        trail: { trades: [onY], signals: [], riskLogs: [] },
      },
    ];
    const occ = [
      occurrence(30),
      {
        ...occurrence(30),
        symbol: OTHER,
        dataProvenance: { ...occurrence(30).dataProvenance, symbol: OTHER },
      },
    ];
    const rows = buildMatrix(
      attribute(occ, runs, timeline, "5m"),
      runs,
      timeline,
    );
    const [pooled] = rowsFor(rows, "ORB_BREAKOUT");
    expect(pooled?.relations?.ENTERED).toBe(2);
    expect(pooled?.trades).toMatchObject({ n: 2, net: 6 });
    expect(rowsFor(rows, "ORB_BREAKOUT", ALL, OTHER)[0]?.trades.net).toBe(-4);
  });

  it("does not depend on the order its inputs arrive in", () => {
    const t = [
      trade(bar(5), 10, 1),
      trade(bar(40), 10, 2),
      trade(bar(60), 5, -3),
    ];
    const occ = [occurrence(5), occurrence(40, "EMA_CROSS"), occurrence(60)];
    const forward = [run("A", t), run("B", [], [entrySignal(bar(40))])];
    const backward = [
      run("B", [], [entrySignal(bar(40))]),
      run("A", [...t].reverse()),
    ];
    const m1 = buildMatrix(
      attribute(occ, forward, timeline, "5m"),
      forward,
      timeline,
    );
    const m2 = buildMatrix(
      attribute([...occ].reverse(), backward, timeline, "5m"),
      backward,
      timeline,
    );
    expect(m2).toEqual(m1);
  });
});
