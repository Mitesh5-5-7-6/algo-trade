import { istDateKey, type Trade } from "@neelkanth/core";
import type { Regime } from "../counterfactual/regime.js";
import {
  meanInterval,
  meanPValue,
  normalQuantile,
  sampleStdDev,
} from "../validation/stats.js";

/** Bumped whenever a metric's definition changes (Phase 13 D2). */
export const BACKTEST_METRICS_VERSION = "1";

/** Sessions a year, for annualising (spec §8.1). */
export const SESSIONS_PER_YEAR = 252;

export interface BacktestMetrics {
  metricsVersion: string;
  /** Trades closed in the window. */
  trades: number;
  sessions: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Gross and net P&L, and both as a fraction of allocated capital. */
  gross: number;
  net: number;
  totalReturn: number;
  netReturn: number;
  charges: number;
  slippage: number;
  expectancy: number | null;
  /** 95% interval of the expectancy; null below two Trades. */
  expectancyInterval: { lower: number; upper: number } | null;
  /** One-sided p that the expectancy exceeds zero; null below two Trades. */
  expectancyPValue: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  /** Gross wins over gross losses; null when there is no losing Trade. */
  profitFactor: number | null;
  /** Annualised, from daily net returns over every session — idle ones too. */
  sharpe: number | null;
  sortino: number | null;
  /** Largest peak-to-trough fall of cumulative net, Trades in exit order. */
  maxDrawdown: number;
  maxDrawdownPct: number;
  averageHoldMinutes: number | null;
  /** Stability: net by calendar month of exit, and the share that was profitable. */
  monthly: { month: string; trades: number; net: number }[];
  profitableMonths: number | null;
  /** Regime dependence: by the regime at entry. */
  byRegime: Record<string, { trades: number; net: number; expectancy: number }>;
}

const round = (x: number, places = 4): number =>
  Math.round(x * 10 ** places) / 10 ** places;

/**
 * The spec's §8.1 metrics over one backtest's Trades (Phase 13 D2). Pure:
 * the Trades, the capital they were sized against, the sessions of the window
 * — every one, so a strategy that trades rarely is not flattered by its idle
 * days being left out — and the regime at each entry.
 */
export function backtestMetrics(
  trades: readonly Trade[],
  window: {
    allocatedCapital: number;
    sessions: readonly string[];
    regimeAt: (ts: number) => Regime | null;
  },
): BacktestMetrics {
  const closed = trades
    .filter(
      (t) =>
        t.status === "CLOSED" &&
        t.netPnl !== undefined &&
        t.exitTime !== undefined,
    )
    .sort(
      (a, b) =>
        (a.exitTime ?? 0) - (b.exitTime ?? 0) ||
        (a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0),
    );
  const nets = closed.map((t) => t.netPnl ?? 0);
  const n = nets.length;
  const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0);
  const net = sum(nets);
  const gross = sum(closed.map((t) => t.grossPnl ?? 0));
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x < 0);
  const capital = window.allocatedCapital;

  // Daily net returns over every session of the window.
  const byDay = new Map(window.sessions.map((d) => [d, 0]));
  for (const t of closed) {
    const day = istDateKey(t.exitTime ?? t.entryTime);
    byDay.set(day, (byDay.get(day) ?? 0) + (t.netPnl ?? 0));
  }
  const daily = [...byDay.values()].map((x) => x / capital);
  const meanDaily = daily.length === 0 ? 0 : sum(daily) / daily.length;
  const sdDaily = daily.length < 2 ? 0 : sampleStdDev(daily);
  const downside =
    daily.length === 0
      ? 0
      : Math.sqrt(sum(daily.map((r) => Math.min(r, 0) ** 2)) / daily.length);
  const annual = Math.sqrt(SESSIONS_PER_YEAR);

  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  for (const x of nets) {
    cumulative += x;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const months = new Map<string, { trades: number; net: number }>();
  for (const t of closed) {
    const month = istDateKey(t.exitTime ?? t.entryTime).slice(0, 7);
    const m = months.get(month) ?? { trades: 0, net: 0 };
    m.trades += 1;
    m.net += t.netPnl ?? 0;
    months.set(month, m);
  }
  const monthly = [...months.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, m]) => ({ month, trades: m.trades, net: round(m.net, 2) }));

  const regimes = new Map<string, { trades: number; net: number }>();
  for (const t of closed) {
    const regime = window.regimeAt(t.entryTime) ?? "UNKNOWN";
    const r = regimes.get(regime) ?? { trades: 0, net: 0 };
    r.trades += 1;
    r.net += t.netPnl ?? 0;
    regimes.set(regime, r);
  }

  const expectancy = n === 0 ? null : net / n;
  const sd = n < 2 ? null : sampleStdDev(nets);
  const z = normalQuantile(0.975);
  return {
    metricsVersion: BACKTEST_METRICS_VERSION,
    trades: n,
    sessions: window.sessions.length,
    wins: wins.length,
    losses: losses.length,
    winRate: n === 0 ? null : round(wins.length / n),
    gross: round(gross, 2),
    net: round(net, 2),
    totalReturn: round(gross / capital, 6),
    netReturn: round(net / capital, 6),
    charges: round(sum(closed.map((t) => t.charges)), 2),
    slippage: round(sum(closed.map((t) => t.slippage)), 2),
    expectancy: expectancy === null ? null : round(expectancy, 2),
    expectancyInterval:
      expectancy === null || sd === null
        ? null
        : (({ lower, upper }) => ({
            lower: round(lower, 2),
            upper: round(upper, 2),
          }))(meanInterval(expectancy, sd, n, z)),
    expectancyPValue:
      expectancy === null || sd === null
        ? null
        : round(meanPValue(expectancy, sd, n, 0, "greater"), 6),
    averageWin: wins.length === 0 ? null : round(sum(wins) / wins.length, 2),
    averageLoss:
      losses.length === 0 ? null : round(sum(losses) / losses.length, 2),
    profitFactor:
      losses.length === 0 ? null : round(sum(wins) / Math.abs(sum(losses))),
    sharpe: sdDaily === 0 ? null : round((meanDaily / sdDaily) * annual),
    sortino: downside === 0 ? null : round((meanDaily / downside) * annual),
    maxDrawdown: round(maxDrawdown, 2),
    maxDrawdownPct: round(maxDrawdown / capital, 6),
    averageHoldMinutes:
      n === 0
        ? null
        : round(
            sum(
              closed.map(
                (t) => ((t.exitTime ?? t.entryTime) - t.entryTime) / 60_000,
              ),
            ) / n,
            1,
          ),
    monthly,
    profitableMonths:
      monthly.length === 0
        ? null
        : round(monthly.filter((m) => m.net > 0).length / monthly.length),
    byRegime: Object.fromEntries(
      [...regimes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([regime, r]) => [
          regime,
          {
            trades: r.trades,
            net: round(r.net, 2),
            expectancy: round(r.net / r.trades, 2),
          },
        ]),
    ),
  };
}
