import { createHash } from "node:crypto";
import {
  canonicalJson,
  istDateKey,
  istDayStart,
  type Candle,
  type CandleInterval,
  type RiskLimits,
  type Trade,
} from "@neelkanth/core";
import type { StrategyCandidateDoc } from "@neelkanth/db";
import type { Regime, RegimeModel } from "../counterfactual/regime.js";
import type { MarketHours } from "../replay/sessions.js";
import { backtestMetrics, type BacktestMetrics } from "./metrics.js";
import { runBacktest, warmupFrom, type Backtest } from "./run.js";

/** Bumped whenever the walk-forward's procedure changes (Phase 13 D4). */
export const WALK_FORWARD_VERSION = "1";

/** The folds (Q2): three months' training, one month's test, one month's step. */
export const TRAIN_MONTHS = 3;
export const TEST_MONTHS = 1;
/** The fewest training Trades a variant needs to be chosen (D4). */
export const MIN_TRAINING_TRADES = 30;

/** `YYYY-MM`'s first and last calendar day. */
export function monthBounds(month: string): {
  fromDate: string;
  toDate: string;
} {
  const [y = 0, m = 0] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    fromDate: `${month}-01`,
    toDate: `${month}-${String(last).padStart(2, "0")}`,
  };
}

const nextMonth = (month: string): string => {
  const [y = 0, m = 0] = month.split("-").map(Number);
  return m === 12
    ? `${String(y + 1)}-01`
    : `${String(y)}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * The months the stored data covers whole (D5): from its first calendar day
 * to its last — a month the data starts inside, or ends inside, is no fold's.
 */
export function completeMonths(
  firstSession: string,
  lastSession: string,
): string[] {
  const out: string[] = [];
  for (
    let m = firstSession.slice(0, 7);
    m <= lastSession.slice(0, 7);
    m = nextMonth(m)
  ) {
    const { fromDate, toDate } = monthBounds(m);
    if (firstSession <= fromDate && lastSession >= toDate) out.push(m);
  }
  return out;
}

export interface FoldPlan {
  train: { fromDate: string; toDate: string };
  test: { fromDate: string; toDate: string };
}

/** Rolling folds over consecutive complete months (Q2). */
export function planFolds(months: readonly string[]): FoldPlan[] {
  const folds: FoldPlan[] = [];
  for (let i = 0; i + TRAIN_MONTHS + TEST_MONTHS <= months.length; i += 1) {
    const train = months.slice(i, i + TRAIN_MONTHS);
    const test = months.slice(i + TRAIN_MONTHS, i + TRAIN_MONTHS + TEST_MONTHS);
    const run = [...train, ...test];
    // Only consecutive calendar months: a gap in the data breaks a fold.
    if (run.some((m, j) => j > 0 && m !== nextMonth(run[j - 1] ?? "")))
      continue;
    folds.push({
      train: {
        fromDate: monthBounds(train[0] ?? "").fromDate,
        toDate: monthBounds(train.at(-1) ?? "").toDate,
      },
      test: {
        fromDate: monthBounds(test[0] ?? "").fromDate,
        toDate: monthBounds(test.at(-1) ?? "").toDate,
      },
    });
  }
  return folds;
}

export interface WalkForwardSettings {
  interval: CandleInterval;
  hours: MarketHours;
  allocatedCapital: number;
  limits: RiskLimits;
  seed: number;
  regime: RegimeModel;
  /** Policy is 30 (D4); lowered only where a test cannot reach it. */
  minTrainingTrades?: number;
}

export interface FoldResult {
  train: FoldPlan["train"];
  test: FoldPlan["test"];
  /** Every variant on the training window: what the choice was made on. */
  training: {
    variant: number;
    trades: number;
    expectancy: number | null;
    fingerprint: string;
  }[];
  /** The variant chosen (1-based), or null when none had enough Trades. */
  chosen: number | null;
  /** The chosen variant on the test window — normal and stressed costs. */
  tested: { normal: string; stressed: string } | null;
  /** The configured strategy on the same test window. */
  baseline: string;
}

export interface WalkForwardResult {
  walkForwardVersion: string;
  candidateId: string;
  candidateFingerprint: string;
  settings: Omit<WalkForwardSettings, "minTrainingTrades"> & {
    minTrainingTrades: number;
  };
  folds: FoldResult[];
  /** The test windows' Trades, pooled — the candidate's out-of-sample record (D4). */
  outOfSample: {
    normal: BacktestMetrics;
    stressed: BacktestMetrics;
    baseline: BacktestMetrics;
  };
  /** How often each variant was chosen: a choice that flips every month is a finding. */
  choices: Record<string, number>;
  fingerprint: string;
}

/** Every backtest a walk-forward ran, by its fingerprint — to keep in `backtests`. */
export type BacktestsRun = Map<
  string,
  { backtest: Backtest; role: string; fold: number }
>;

/** The bars a window's backtest reads: its warm-up lead, the window, nothing after. */
const slice = (
  candles: readonly Candle[],
  w: { fromDate: string; toDate: string },
) => {
  const from = istDayStart(warmupFrom(w.fromDate));
  const to = istDayStart(w.toDate) + 86_400_000;
  return candles.filter((c) => c.ts >= from && c.ts < to);
};

/**
 * Walk a candidate forward (Phase 13 D4, D5): in each fold, every variant of
 * its grid backtested on the training window, the one with the highest
 * training expectancy among those with enough Trades chosen (ties: the
 * grid's first), and only it run on the test window — under normal and
 * stressed costs — beside the configured strategy. The test window never
 * informs a choice. Pure over the bars handed to it.
 */
export async function walkForward(
  candles: readonly Candle[],
  candidate: StrategyCandidateDoc,
  folds: readonly FoldPlan[],
  settings: WalkForwardSettings,
): Promise<{ result: WalkForwardResult; backtests: BacktestsRun }> {
  const minTrades = settings.minTrainingTrades ?? MIN_TRAINING_TRADES;
  const backtests: BacktestsRun = new Map();
  const run = async (
    w: { fromDate: string; toDate: string },
    params: Record<string, unknown>,
    stressed: boolean,
    role: string,
    fold: number,
  ): Promise<Backtest> => {
    const b = await runBacktest(slice(candles, w), {
      strategyType: candidate.strategyType,
      params,
      symbols: candidate.symbols,
      interval: settings.interval,
      fromDate: w.fromDate,
      toDate: w.toDate,
      hours: settings.hours,
      allocatedCapital: settings.allocatedCapital,
      limits: settings.limits,
      seed: settings.seed,
      regime: settings.regime,
      stressed,
    });
    backtests.set(b.fingerprint, { backtest: b, role, fold });
    return b;
  };

  const pooled = {
    normal: [] as Trade[],
    stressed: [] as Trade[],
    baseline: [] as Trade[],
  };
  const regimes = new Map<number, Regime | null>();
  const sessions = new Set<string>();
  const results: FoldResult[] = [];
  const choices: Record<string, number> = {};
  for (const [f, plan] of folds.entries()) {
    const training: FoldResult["training"] = [];
    for (const [i, params] of candidate.grid.entries()) {
      const b = await run(
        plan.train,
        params,
        false,
        `train:variant${String(i + 1)}`,
        f + 1,
      );
      training.push({
        variant: i + 1,
        trades: b.metrics.trades,
        expectancy: b.metrics.expectancy,
        fingerprint: b.fingerprint,
      });
    }
    // The choice: on training alone.
    const eligible = training.filter(
      (t) => t.trades >= minTrades && t.expectancy !== null,
    );
    const best = eligible.reduce<(typeof eligible)[number] | undefined>(
      (m, t) =>
        m === undefined ||
        (t.expectancy ?? -Infinity) > (m.expectancy ?? -Infinity)
          ? t
          : m,
      undefined,
    );
    const chosen = best?.variant ?? null;
    choices[chosen === null ? "none" : `variant${String(chosen)}`] =
      (choices[chosen === null ? "none" : `variant${String(chosen)}`] ?? 0) + 1;

    const baseline = await run(plan.test, {}, false, "baseline", f + 1);
    pooled.baseline.push(...baseline.trail.trades);
    for (const t of baseline.trail.trades)
      regimes.set(t.entryTime, baseline.trail.regimeAtEntry(t.entryTime));
    for (const c of candles)
      if (candidate.symbols.includes(c.symbol)) {
        const d = istDateKey(c.ts);
        if (d >= plan.test.fromDate && d <= plan.test.toDate) sessions.add(d);
      }
    let tested: FoldResult["tested"] = null;
    if (chosen !== null) {
      const params = candidate.grid[chosen - 1] ?? {};
      const normal = await run(plan.test, params, false, "test", f + 1);
      const stressed = await run(
        plan.test,
        params,
        true,
        "test:stressed",
        f + 1,
      );
      pooled.normal.push(...normal.trail.trades);
      pooled.stressed.push(...stressed.trail.trades);
      for (const b of [normal, stressed])
        for (const t of b.trail.trades)
          regimes.set(t.entryTime, b.trail.regimeAtEntry(t.entryTime));
      tested = { normal: normal.fingerprint, stressed: stressed.fingerprint };
    }
    results.push({
      train: plan.train,
      test: plan.test,
      training,
      chosen,
      tested,
      baseline: baseline.fingerprint,
    });
  }

  const window = {
    allocatedCapital: settings.allocatedCapital * candidate.symbols.length,
    sessions: [...sessions].sort(),
    regimeAt: (ts: number) => regimes.get(ts) ?? null,
  };
  const body = {
    walkForwardVersion: WALK_FORWARD_VERSION,
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.fingerprint,
    settings: { ...settings, minTrainingTrades: minTrades },
    folds: results,
    outOfSample: {
      normal: backtestMetrics(pooled.normal, window),
      stressed: backtestMetrics(pooled.stressed, window),
      baseline: backtestMetrics(pooled.baseline, window),
    },
    choices,
  };
  return {
    result: {
      ...body,
      fingerprint: createHash("sha256")
        .update(canonicalJson(body))
        .digest("hex"),
    },
    backtests,
  };
}
