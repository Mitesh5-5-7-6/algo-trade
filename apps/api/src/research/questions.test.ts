import { describe, expect, it } from "vitest";
import type { Aggregate, ConditionRow, PairRow, Tally } from "./aggregate.js";
import {
  monthlyAnswers,
  quarterlyAnswers,
  THRESHOLDS,
  weeklyAnswers,
} from "./questions.js";

/** Task 9.3 (design D4): each window answers its own questions, with n, by stated thresholds. */
function tally(n: number, net: number, over: Partial<Tally> = {}): Tally {
  return {
    n,
    wins: 0,
    losses: 0,
    net,
    expectancy: n === 0 ? null : net / n,
    charges: 0,
    slippage: 0,
    daysTraded: 0,
    winningDays: 0,
    losingDays: 0,
    ...over,
  };
}
function pair(
  patternId: string,
  strategyType: string,
  regime: string,
  trades: Tally,
  daysOccurred = 1,
): PairRow {
  return {
    patternId,
    strategyType,
    regime: regime as PairRow["regime"],
    occurrences: daysOccurred,
    daysOccurred,
    relations: { ENTERED: trades.n, SIGNALLED: 0, HOLDING: 0, FLAT: 0 },
    trades,
  };
}
function condition(
  strategyType: string,
  regime: "BULLISH" | "BEARISH",
  preceding: string,
  trades: Tally,
): ConditionRow {
  return { strategyType, regime, preceding, trades };
}
const agg = (pairs: PairRow[], conditions: ConditionRow[] = []): Aggregate => ({
  days: [],
  instruments: [],
  pairs,
  strategies: [],
  conditions,
});

describe("the week — recurring behaviour (9.3, D4)", () => {
  /** 60% of a four-day (holiday) week is three days. */
  it("finds patterns that recurred across the week's trading days", () => {
    const week = agg([
      pair("ORB_BREAKOUT", "ORB", "ALL", tally(4, 20, { losingDays: 1 }), 3),
      pair("EMA_CROSS", "ORB", "ALL", tally(1, -5), 2),
    ]);
    const a = weeklyAnswers(week, 4);
    expect(a.recurred.map((r) => [r.patternId, r.daysOccurred])).toEqual([
      ["ORB_BREAKOUT", 3],
    ]);
    expect(a.worked.map((r) => r.patternId)).toEqual(["ORB_BREAKOUT"]);
  });

  /** Which patterns recurred — and which strategies did anything with them. */
  it("lists each recurring pattern once, with only the strategies that acted on it", () => {
    const stoodAside = pair("ORB_BREAKOUT", "RSI", "ALL", tally(0, 0), 3);
    stoodAside.relations = { ENTERED: 0, SIGNALLED: 0, HOLDING: 0, FLAT: 3 };
    const a = weeklyAnswers(
      agg([pair("ORB_BREAKOUT", "ORB", "ALL", tally(3, 12), 3), stoodAside]),
      4,
    );
    expect(a.recurred).toHaveLength(1);
    expect(
      a.recurred[0]?.strategies.map((s) => [
        s.strategyType,
        s.entered,
        s.trades.net,
      ]),
    ).toEqual([["ORB", 3, 12]]);
  });

  /** Two holidays leave three trading days: 60% of three is two, not the three a five-day week would need. */
  it("counts recurrence against the week's trading days, not five", () => {
    const short = agg([pair("ORB_BREAKOUT", "ORB", "ALL", tally(2, 4), 2)]);
    expect(weeklyAnswers(short, 3).recurred).toHaveLength(1);
    expect(weeklyAnswers(short, 5).recurred).toHaveLength(0);
  });

  it("finds a strategy that failed with a pattern on repeated days — and in total", () => {
    const a = weeklyAnswers(
      agg([
        pair(
          "RSI_REVERSION",
          "RSI",
          "ALL",
          tally(6, -40, { losingDays: 3 }),
          4,
        ),
        pair("ORB_BREAKOUT", "ORB", "ALL", tally(6, 10, { losingDays: 2 }), 4), // lost on two days, made money overall
        pair(
          "EMA_CROSS",
          "EMA_CROSSOVER",
          "ALL",
          tally(2, -9, { losingDays: 1 }),
          2,
        ), // lost once
      ]),
      5,
    );
    expect(a.failedRepeatedly.map((r) => r.patternId)).toEqual([
      "RSI_REVERSION",
    ]);
  });
});

describe("the month — weaknesses and opportunities (9.3, D4)", () => {
  const month = agg(
    [
      pair("EMA_CROSS", "EMA_CROSSOVER", "ALL", tally(30, 300)),
      pair("RSI_REVERSION", "RSI", "ALL", tally(40, -800)),
      pair("ORB_BREAKOUT", "ORB", "ALL", tally(20, -100)),
    ],
    [
      condition("RSI", "BEARISH", "RSI_REVERSION", tally(25, -700)),
      condition("RSI", "BULLISH", "NONE", tally(15, 200)),
      condition("ORB", "BEARISH", "ORB_BREAKOUT", tally(9, -900)), // too few to rank
      condition("EMA_CROSSOVER", "BULLISH", "EMA_CROSS", tally(30, 300)),
    ],
  );
  const a = monthlyAnswers(month);

  it("ranks only conditions with enough Trades", () => {
    expect(a.weaknesses.map((c) => [c.strategyType, c.preceding])).toEqual([
      ["RSI", "RSI_REVERSION"],
    ]);
    expect(a.opportunities.map((c) => [c.strategyType, c.trades.net])).toEqual([
      ["EMA_CROSSOVER", 300],
      ["RSI", 200],
    ]);
  });

  it("names the most profitable pairing and the largest loss", () => {
    expect(a.mostProfitable?.patternId).toBe("EMA_CROSS");
    expect(a.largestLoss?.patternId).toBe("RSI_REVERSION");
  });

  /** RSI: −28 a Trade in BEARISH, +13.3 in BULLISH, each on ≥ 10 Trades. */
  it("says whether a strategy's expectancy changed sign between regimes", () => {
    const rsi = a.regimes.find((r) => r.strategyType === "RSI");
    expect(rsi?.changedSign).toBe(true);
    expect(rsi?.byRegime["BEARISH"]).toEqual({ n: 25, expectancy: -28 });
    expect(
      a.regimes.find((r) => r.strategyType === "EMA_CROSSOVER")?.changedSign,
    ).toBe(false);
  });

  it("claims no extreme it does not have", () => {
    const flat = monthlyAnswers(
      agg([pair("EMA_CROSS", "ORB", "ALL", tally(0, 0))]),
    );
    expect([flat.mostProfitable, flat.largestLoss]).toEqual([null, null]);
  });
});

describe("the quarter — survival across regimes and months (9.3, D4)", () => {
  const quarter = (bull: Tally, bear: Tally) =>
    agg([
      pair("X", "S", "ALL", tally(bull.n + bear.n, bull.net + bear.net)),
      pair("X", "S", "BULLISH", bull),
      pair("X", "S", "BEARISH", bear),
    ]);
  const months = (...nets: [number, number][]) =>
    Object.fromEntries(
      nets.map(([n, net], i) => [
        `2026-0${String(i + 1)}`,
        agg([pair("X", "S", "ALL", tally(n, net))]),
      ]),
    );
  const verdictOf = (q: Aggregate, m: Record<string, Aggregate>) =>
    quarterlyAnswers(q, m).pairs[0]?.verdict;

  it("SURVIVES: the same sign in every regime and every month with enough Trades", () => {
    expect(
      verdictOf(
        quarter(tally(20, -100), tally(15, -60)),
        months([12, -50], [11, -40], [12, -70]),
      ),
    ).toBe("SURVIVES");
  });
  it("REGIME_DEPENDENT: the regimes disagree", () => {
    expect(
      verdictOf(
        quarter(tally(20, 100), tally(15, -60)),
        months([12, 10], [11, -40], [12, 30]),
      ),
    ).toBe("REGIME_DEPENDENT");
  });
  it("UNSTABLE: the regimes agree, a month does not", () => {
    expect(
      verdictOf(
        quarter(tally(20, -100), tally(15, -60)),
        months([12, -50], [11, 40], [12, -70]),
      ),
    ).toBe("UNSTABLE");
  });
  /** A month with too few Trades does not get a vote. */
  it("ignores months with too few Trades", () => {
    expect(
      verdictOf(
        quarter(tally(20, -100), tally(15, -60)),
        months([12, -50], [THRESHOLDS.minMonthTrades - 1, 40], [12, -70]),
      ),
    ).toBe("SURVIVES");
  });
  it("INSUFFICIENT: one regime cannot show survival across regimes", () => {
    const q = quarterlyAnswers(
      quarter(tally(30, -100), tally(9, 50)),
      months([12, -50]),
    );
    expect(q.pairs[0]).toMatchObject({ verdict: "INSUFFICIENT" });
    expect(q.pairs[0]?.because).toMatch(
      /1 regime\(s\) with at least 10 Trades/,
    );
  });
});
