import {
  istDateKey,
  type Candle,
  type PatternOccurrence,
  type Signal,
  type Trade,
} from "@neelkanth/core";
import { entryBarOf, type Attribution } from "../counterfactual/attribution.js";
import {
  evaluateMarket,
  type CounterfactualRequest,
  type MarketEvaluation,
} from "../counterfactual/run.js";

/** Bumped whenever what a daily report is, or how it is made, changes. */
export const DAILY_RESEARCH_VERSION = "1";

/** Sessions in a day's run: the day itself and its warm-up (Phase 8 D1). */
export const DEFAULT_LOOKBACK_SESSIONS = 5;

export interface DayRunRequest extends Omit<CounterfactualRequest, "candles"> {
  /** The IST trading date reported. */
  date: string;
  /**
   * Bars available — any range, as long as it covers the window. Only the
   * last `lookbackSessions` sessions ending at `date` are read.
   */
  candles: readonly Candle[];
  lookbackSessions?: number;
}

/** One strategy's day on one symbol: what it decided and traded on D. */
export interface StrategyDay {
  strategyType: string;
  symbol: string;
  /** Signals made on D's bars — HOLDs and mechanical exits included. */
  signals: Signal[];
  /** Trades whose entry was decided on D. */
  trades: Trade[];
}

/** A day's run (Phase 8 D1), D alone. */
export interface DayRun {
  date: string;
  /** The sessions the run read, oldest first; the last is `date`. */
  sessions: string[];
  /** The bars it read — every one — so its inputs can be fingerprinted (D5). */
  bars: Candle[];
  evaluation: MarketEvaluation;
  /** Occurrences on D. */
  occurrences: PatternOccurrence[];
  /** Each of D's occurrences put to each strategy on its symbol. */
  attributions: Attribution[];
  strategyDays: StrategyDay[];
}

/**
 * The trading sessions — dates with bars — up to and including `date`, last
 * `count` of them. The calendar is the one the bars declare: a holiday has
 * no bars and is no session; a Budget Sunday has bars and is one.
 */
export function sessionsEndingAt(
  candles: readonly Candle[],
  date: string,
  count: number,
): string[] {
  const dates = [...new Set(candles.map((c) => istDateKey(c.ts)))]
    .filter((d) => d <= date)
    .sort();
  if (dates.at(-1) !== date)
    throw new Error(
      `no session on ${date}: the bars hold no trading day there`,
    );
  return dates.slice(-count);
}

/**
 * Run one trading day (Phase 8 D1): the counterfactual run over the K
 * sessions ending at D, reported for D alone.
 *
 * A function of D, its bars and its declared models only. Bars after D are
 * never read (§5.4), and bars before the window are never read either — so a
 * report is the same whatever range the caller happened to load, and the
 * same tonight as next year.
 */
export async function runDay(request: DayRunRequest): Promise<DayRun> {
  const k = request.lookbackSessions ?? DEFAULT_LOOKBACK_SESSIONS;
  if (!Number.isInteger(k) || k < 1)
    throw new Error(
      `lookbackSessions must be a positive integer, got ${String(k)}`,
    );
  const sessions = sessionsEndingAt(request.candles, request.date, k);
  const window = new Set(sessions);
  const bars = request.candles
    .filter((c) => window.has(istDateKey(c.ts)))
    .sort(
      (a, b) =>
        a.ts - b.ts || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );

  // The window's bars, and only those: the rest of the request is the run's.
  const evaluation = await evaluateMarket({ ...request, candles: bars });
  const onDay = (ts: number): boolean => istDateKey(ts) === request.date;

  const strategyDays: StrategyDay[] = evaluation.runs.map((run) => ({
    strategyType: run.strategyType,
    symbol: run.symbol,
    signals: run.trail.signals.filter((s) =>
      onDay(s.dataProvenance?.barTs ?? s.ts),
    ),
    trades: run.trail.trades.filter((t) => onDay(entryBarOf(t))),
  }));
  return {
    date: request.date,
    sessions,
    bars,
    evaluation,
    occurrences: evaluation.occurrences.filter((o) => onDay(o.ts)),
    attributions: evaluation.attributions.filter((a) => onDay(a.ts)),
    strategyDays,
  };
}
