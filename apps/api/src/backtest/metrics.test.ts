import { describe, expect, it } from "vitest";
import { istDayStart, type Trade } from "@neelkanth/core";
import { backtestMetrics } from "./metrics.js";

/** Task 13.1 (design D2): the §8.1 metrics, against values worked by hand. */
const at = (date: string, minutes: number) =>
  istDayStart(date) + (9 * 60 + 15 + minutes) * 60_000;
const trade = (id: string, exitDate: string, net: number): Trade =>
  ({
    tradeId: id,
    status: "CLOSED",
    entryTime: at(exitDate, 30),
    exitTime: at(exitDate, 60),
    quantity: 10,
    grossPnl: net + 20,
    charges: 15,
    slippage: 5,
    netPnl: net,
  }) as unknown as Trade;

const SESSIONS = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
const TRADES = [
  trade("t1", "2026-01-05", 300),
  trade("t2", "2026-01-06", -100),
  trade("t3", "2026-01-08", 200),
];
// The regime turns BEARISH at 10:00 on 2026-01-08 — after t3 entered (09:45), before it exited (10:15).
const regimeAt = (ts: number) =>
  ts < at("2026-01-08", 45) ? ("BULLISH" as const) : ("BEARISH" as const);
const m = backtestMetrics(TRADES, {
  allocatedCapital: 100_000,
  sessions: SESSIONS,
  regimeAt,
});

describe("backtest metrics (13.1, D2)", () => {
  it("counts, P&L, returns and costs", () => {
    expect(m).toMatchObject({
      metricsVersion: "1",
      trades: 3,
      sessions: 4,
      wins: 2,
      losses: 1,
      winRate: 0.6667,
      gross: 460,
      net: 400,
      totalReturn: 0.0046,
      netReturn: 0.004,
      charges: 45,
      slippage: 15,
      averageWin: 250,
      averageLoss: -100,
      profitFactor: 5,
      averageHoldMinutes: 30,
    });
  });

  it("expectancy with its interval and one-sided p", () => {
    // nets 300, −100, 200: mean 133.33, sd 208.17; ±1.96·sd/√3 = ±235.57.
    expect(m.expectancy).toBe(133.33);
    expect(m.expectancyInterval?.lower).toBeCloseTo(-102.24, 1);
    expect(m.expectancyInterval?.upper).toBeCloseTo(368.9, 1);
    // z = 133.33 / (208.17/√3) = 1.109 → p = 0.1336.
    expect(m.expectancyPValue).toBeCloseTo(0.1336, 3);
  });

  it("Sharpe and Sortino from daily returns over every session — the idle day included", () => {
    // daily: .003, −.001, 0, .002 → mean .001, sd .0018257; √252 = 15.8745.
    expect(m.sharpe).toBeCloseTo(8.6948, 3);
    // downside deviation √(.001²/4) = .0005.
    expect(m.sortino).toBeCloseTo(31.749, 2);
    // Leaving the idle day out would flatter it.
    const without = backtestMetrics(TRADES, {
      allocatedCapital: 100_000,
      sessions: SESSIONS.filter((d) => d !== "2026-01-07"),
      regimeAt,
    });
    expect(without.sharpe ?? 0).toBeGreaterThan(m.sharpe ?? 0);
  });

  it("drawdown, stability and regime dependence", () => {
    // cumulative 300, 200, 400: the fall from 300 to 200.
    expect(m).toMatchObject({ maxDrawdown: 100, maxDrawdownPct: 0.001 });
    expect(m.monthly).toEqual([{ month: "2026-01", trades: 3, net: 400 }]);
    expect(m.profitableMonths).toBe(1);
    // By the regime at ENTRY: t3 entered BULLISH, though it closed BEARISH.
    expect(m.byRegime).toEqual({
      BULLISH: { trades: 3, net: 400, expectancy: 133.33 },
    });
  });

  it("says nothing it cannot: no Trades, no losses, an open Trade", () => {
    const empty = backtestMetrics([], {
      allocatedCapital: 1,
      sessions: SESSIONS,
      regimeAt,
    });
    expect(empty).toMatchObject({
      trades: 0,
      winRate: null,
      expectancy: null,
      expectancyInterval: null,
      expectancyPValue: null,
      profitFactor: null,
      sharpe: null,
      sortino: null,
      profitableMonths: null,
    });
    const allWins = backtestMetrics(
      [trade("a", "2026-01-05", 10), trade("b", "2026-01-06", 20)],
      {
        allocatedCapital: 1_000,
        sessions: SESSIONS,
        regimeAt,
      },
    );
    expect(allWins.profitFactor).toBeNull(); // no losing Trade to divide by
    expect(allWins.sortino).toBeNull(); // no downside
    const open = {
      ...trade("o", "2026-01-05", 0),
      status: "OPEN", // still open: its exit and P&L are provisional
    } as unknown as Trade;
    expect(
      backtestMetrics([open, ...TRADES], {
        allocatedCapital: 100_000,
        sessions: SESSIONS,
        regimeAt,
      }).trades,
    ).toBe(3);
  });
});
