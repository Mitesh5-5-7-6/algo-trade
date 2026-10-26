import { describe, expect, it } from "vitest";
import type { TradeEvidence } from "./evidence.js";
import type { PatternObservation } from "./observations.js";
import { aggregate, type DailyInput } from "./aggregate.js";

/** Task 9.2 (design D3): one aggregation over daily reports, n on every row, and how it fell across days. */
const SYM = "NSE:X-INDEX";
let seq = 0;
function trade(
  strategyType: string,
  net: number,
  over: Partial<TradeEvidence> = {},
): TradeEvidence {
  seq += 1;
  return {
    key: `${strategyType}|${SYM}|trd_1`, // the same per-day key every day, as replays number from one
    tradeId: "trd_1",
    strategyType,
    symbol: SYM,
    side: "LONG",
    quantity: 10,
    entry: {
      signalId: `sig_${String(seq)}`,
      barTs: 0,
      time: 0,
      price: 100,
      reason: null,
    },
    exit: {
      time: 1,
      price: 100 + net / 10,
      reason: net >= 0 ? "TAKE_PROFIT" : "STOP_LOSS",
    },
    outcome: {
      result: net > 0 ? "WIN" : net < 0 ? "LOSS" : "FLAT",
      gross: net + 2,
      charges: 2,
      slippage: 1,
      net,
      netPerUnit: net / 10,
    },
    held: { bars: 3, minutes: 15 },
    excursion: { favourable: 1, adverse: 1 },
    preceding: { regime: "BULLISH", patterns: [] },
    ...over,
  };
}
function pattern(
  patternId: string,
  regime: "BULLISH" | "BEARISH",
  strategies: PatternObservation["strategies"],
): PatternObservation {
  return {
    patternId,
    detectorVersion: "1.0.0",
    ts: 0,
    direction: "BULLISH",
    evidence: {},
    marketContext: {},
    regime,
    strategies,
  };
}
const day = (
  date: string,
  patterns: PatternObservation[],
  trades: TradeEvidence[],
): DailyInput => ({ date, symbol: SYM, patterns, trades });

describe("pooling daily reports (9.2, D3)", () => {
  const t1 = trade("ORB", 30);
  const t2 = trade("ORB", -10);
  const reports = [
    day(
      "2026-03-02",
      [
        pattern("ORB_BREAKOUT", "BULLISH", {
          ORB: { relation: "ENTERED", tradeKey: t1.key },
          RSI: { relation: "FLAT" },
        }),
        pattern("ORB_BREAKOUT", "BULLISH", {
          ORB: { relation: "HOLDING", tradeKey: t1.key },
          RSI: { relation: "FLAT" },
        }),
      ],
      [t1],
    ),
    day(
      "2026-03-04",
      [
        pattern("ORB_BREAKOUT", "BEARISH", {
          ORB: { relation: "ENTERED", tradeKey: t2.key },
          RSI: { relation: "SIGNALLED" },
        }),
      ],
      [t2],
    ),
  ];
  const agg = aggregate(reports);
  const pair = (p: string, s: string, r = "ALL") =>
    agg.pairs.find(
      (x) => x.patternId === p && x.strategyType === s && x.regime === r,
    );

  it("counts occurrences, the days they fell on, and every strategy's relation", () => {
    expect(pair("ORB_BREAKOUT", "ORB")).toMatchObject({
      occurrences: 3,
      daysOccurred: 2,
      relations: { ENTERED: 2, SIGNALLED: 0, HOLDING: 1, FLAT: 0 },
    });
    expect(pair("ORB_BREAKOUT", "RSI")?.relations).toEqual({
      ENTERED: 0,
      SIGNALLED: 1,
      HOLDING: 0,
      FLAT: 2,
    });
    expect(agg.days).toEqual(["2026-03-02", "2026-03-04"]);
  });

  /** Both days' Trades carry the key ORB|…|trd_1 — they must stay two Trades. */
  it("keeps Trades from different days apart, though their per-day keys repeat", () => {
    expect(pair("ORB_BREAKOUT", "ORB")?.trades).toMatchObject({
      n: 2,
      wins: 1,
      losses: 1,
      net: 20,
      expectancy: 10,
    });
  });

  it("says how a row fell across days", () => {
    expect(pair("ORB_BREAKOUT", "ORB")?.trades).toMatchObject({
      daysTraded: 2,
      winningDays: 1,
      losingDays: 1,
    });
  });

  it("splits by the regime at each occurrence, and pools it as ALL", () => {
    expect(pair("ORB_BREAKOUT", "ORB", "BULLISH")?.trades.net).toBe(30);
    expect(pair("ORB_BREAKOUT", "ORB", "BEARISH")?.trades.net).toBe(-10);
    expect(pair("ORB_BREAKOUT", "ORB", "BULLISH")?.daysOccurred).toBe(1);
  });

  it("summarises each strategy with its exits", () => {
    expect(agg.strategies).toEqual([
      {
        strategyType: "ORB",
        trades: expect.objectContaining({
          n: 2,
          net: 20,
          charges: 4,
          slippage: 2,
        }) as unknown,
        exits: { STOP_LOSS: 1, TAKE_PROFIT: 1 },
      },
    ]);
  });

  it("does not depend on the order of the reports", () => {
    expect(aggregate([...reports].reverse())).toEqual(agg);
  });

  it("refuses a report that points at a Trade it does not hold", () => {
    const broken = day(
      "2026-03-05",
      [
        pattern("EMA_CROSS", "BULLISH", {
          ORB: { relation: "ENTERED", tradeKey: "ORB|X|trd_9" },
        }),
      ],
      [],
    );
    expect(() => aggregate([broken])).toThrow(/does not hold/);
  });
});

/** Day-level means the day's Trades in sum: +5 and −3 on one day is one winning day, not one of each. */
describe("day-level consistency (9.2, D3)", () => {
  it("judges a day by its Trades in sum", () => {
    const a = trade("EMA_CROSSOVER", 5, { key: "EMA_CROSSOVER|X|trd_1" });
    const b = trade("EMA_CROSSOVER", -3, { key: "EMA_CROSSOVER|X|trd_2" });
    const c = trade("EMA_CROSSOVER", -4, { key: "EMA_CROSSOVER|X|trd_1" });
    const agg = aggregate([
      day("2026-03-02", [], [a, b]),
      day("2026-03-03", [], [c]),
    ]);
    expect(agg.strategies[0]?.trades).toMatchObject({
      n: 3,
      wins: 1,
      losses: 2,
      daysTraded: 2,
      winningDays: 1,
      losingDays: 1,
    });
  });
});

describe("conditions — what preceded each entry (9.2, D3)", () => {
  it("groups Trades by strategy, entry regime and the patterns before them", () => {
    const after = (ids: string[]) => ({
      regime: "BEARISH" as const,
      patterns: ids.map((patternId, i) => ({
        patternId,
        detectorVersion: "1.0.0",
        direction: "BULLISH",
        ts: i,
        barsBeforeEntry: i,
      })),
    });
    const agg = aggregate([
      day(
        "2026-03-02",
        [],
        [
          trade("RSI", -5, {
            preceding: after(["RSI_REVERSION", "ORB_BREAKOUT"]),
          }),
        ],
      ),
      day(
        "2026-03-03",
        [],
        [
          trade("RSI", -7, {
            preceding: after([
              "ORB_BREAKOUT",
              "RSI_REVERSION",
              "RSI_REVERSION",
            ]),
          }),
        ],
      ),
      day("2026-03-04", [], [trade("RSI", 4)]),
    ]);
    expect(
      agg.conditions.map((c) => [
        c.strategyType,
        c.regime,
        c.preceding,
        c.trades.n,
        c.trades.net,
      ]),
    ).toEqual([
      ["RSI", "BEARISH", "ORB_BREAKOUT+RSI_REVERSION", 2, -12],
      ["RSI", "BULLISH", "NONE", 1, 4],
    ]);
  });
});
