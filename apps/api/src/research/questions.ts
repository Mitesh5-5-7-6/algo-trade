import { ALL } from "../counterfactual/matrix.js";
import type { Aggregate, ConditionRow, PairRow, Tally } from "./aggregate.js";

/** Bumped whenever what a window report answers, or how, changes (Phase 9 D4). */
export const PERIODIC_RESEARCH_VERSION = "1";

/** The thresholds the answers are drawn with — on every report, so a reader can disagree. */
export const THRESHOLDS = {
  /** A pair recurred if it occurred on at least this share of the week's trading days. */
  recurrenceShare: 0.6,
  /** A strategy failed repeatedly with a pattern if it lost on at least this many days. */
  repeatedFailureDays: 2,
  /** Conditions ranked as weaknesses or opportunities need at least this many Trades. */
  minConditionTrades: 10,
  /** A regime counts towards survival only with at least this many Trades. */
  minRegimeTrades: 10,
  /** A month counts towards stability only with at least this many Trades. */
  minMonthTrades: 5,
  /** How many weaknesses and opportunities a month lists. */
  top: 5,
} as const;
export type Thresholds = typeof THRESHOLDS;

const sign = (x: number | null): -1 | 0 | 1 =>
  x === null || x === 0 ? 0 : x > 0 ? 1 : -1;
const pooled = (agg: Aggregate): PairRow[] =>
  agg.pairs.filter((p) => p.regime === ALL);

/** The week (spec Phase 9): recurrence, what worked, what failed repeatedly. */
export interface WeeklyAnswers {
  tradingDays: number;
  /**
   * Patterns that occurred on enough of the week's days — the findings that
   * repeat across days — each with the strategies that acted on it (entered,
   * signalled or held), and what their Trades on it made. A strategy that
   * only ever stood aside is left out: it says nothing about what worked.
   */
  recurred: {
    patternId: string;
    daysOccurred: number;
    occurrences: number;
    strategies: {
      strategyType: string;
      entered: number;
      signalled: number;
      holding: number;
      trades: Tally;
    }[];
  }[];
  /** Strategies that made money on a pattern this week, with n. */
  worked: { patternId: string; strategyType: string; trades: Tally }[];
  /** Strategies that lost on a pattern on repeated days, and in total. */
  failedRepeatedly: {
    patternId: string;
    strategyType: string;
    trades: Tally;
  }[];
}

export function weeklyAnswers(
  agg: Aggregate,
  tradingDays: number,
  t: Thresholds = THRESHOLDS,
): WeeklyAnswers {
  const rows = pooled(agg);
  const need = Math.ceil(tradingDays * t.recurrenceShare);
  return {
    tradingDays,
    // Every strategy sees every occurrence, so a pattern's days and count are
    // the same on each of its rows; the first stands for all.
    recurred: [...new Set(rows.map((p) => p.patternId))]
      .map((patternId) => rows.filter((p) => p.patternId === patternId))
      .filter(
        ([first]) =>
          first !== undefined && tradingDays > 0 && first.daysOccurred >= need,
      )
      .map((pairs) => ({
        patternId: pairs[0]?.patternId ?? "",
        daysOccurred: Math.max(...pairs.map((p) => p.daysOccurred)),
        occurrences: Math.max(...pairs.map((p) => p.occurrences)),
        strategies: pairs
          .filter(
            (p) =>
              p.relations.ENTERED +
                p.relations.SIGNALLED +
                p.relations.HOLDING >
              0,
          )
          .map((p) => ({
            strategyType: p.strategyType,
            entered: p.relations.ENTERED,
            signalled: p.relations.SIGNALLED,
            holding: p.relations.HOLDING,
            trades: p.trades,
          })),
      })),
    worked: rows
      .filter((p) => p.trades.n > 0 && p.trades.net > 0)
      .map((p) => ({
        patternId: p.patternId,
        strategyType: p.strategyType,
        trades: p.trades,
      })),
    failedRepeatedly: rows
      .filter(
        (p) => p.trades.losingDays >= t.repeatedFailureDays && p.trades.net < 0,
      )
      .map((p) => ({
        patternId: p.patternId,
        strategyType: p.strategyType,
        trades: p.trades,
      })),
  };
}

/** The month (spec Phase 9): weaknesses, opportunities, extremes, regime change. */
export interface MonthlyAnswers {
  /** The costliest conditions with enough Trades — what recurs and loses. */
  weaknesses: ConditionRow[];
  /** The best conditions with enough Trades. */
  opportunities: ConditionRow[];
  mostProfitable: {
    patternId: string;
    strategyType: string;
    trades: Tally;
  } | null;
  largestLoss: {
    patternId: string;
    strategyType: string;
    trades: Tally;
  } | null;
  /** Per strategy: expectancy by regime, and whether it changed sign across them. */
  regimes: {
    strategyType: string;
    byRegime: Record<string, { n: number; expectancy: number | null }>;
    changedSign: boolean;
  }[];
}

export function monthlyAnswers(
  agg: Aggregate,
  t: Thresholds = THRESHOLDS,
): MonthlyAnswers {
  const enough = agg.conditions.filter(
    (c) => c.trades.n >= t.minConditionTrades,
  );
  const traded = pooled(agg).filter((p) => p.trades.n > 0);
  const byNet = [...traded].sort((a, b) => b.trades.net - a.trades.net);
  const best = byNet[0];
  const worst = byNet.at(-1);
  const strategies = [...new Set(agg.pairs.map((p) => p.strategyType))].sort();
  return {
    weaknesses: enough
      .filter((c) => (c.trades.expectancy ?? 0) < 0)
      .sort((a, b) => a.trades.net - b.trades.net)
      .slice(0, t.top),
    opportunities: enough
      .filter((c) => (c.trades.expectancy ?? 0) > 0)
      .sort((a, b) => b.trades.net - a.trades.net)
      .slice(0, t.top),
    mostProfitable:
      best !== undefined && best.trades.net > 0
        ? {
            patternId: best.patternId,
            strategyType: best.strategyType,
            trades: best.trades,
          }
        : null,
    largestLoss:
      worst !== undefined && worst.trades.net < 0
        ? {
            patternId: worst.patternId,
            strategyType: worst.strategyType,
            trades: worst.trades,
          }
        : null,
    regimes: strategies.map((strategyType) => {
      const byRegime: Record<string, { n: number; expectancy: number | null }> =
        {};
      for (const c of agg.conditions.filter(
        (x) => x.strategyType === strategyType,
      )) {
        const cur = byRegime[c.regime] ?? { n: 0, expectancy: 0 };
        const net = (cur.expectancy ?? 0) * cur.n + c.trades.net;
        const n = cur.n + c.trades.n;
        byRegime[c.regime] = {
          n,
          expectancy: n === 0 ? null : Math.round((net / n) * 1e4) / 1e4,
        };
      }
      const signs = new Set(
        Object.values(byRegime)
          .filter((r) => r.n >= t.minRegimeTrades)
          .map((r) => sign(r.expectancy)),
      );
      return { strategyType, byRegime, changedSign: signs.size > 1 };
    }),
  };
}

export type SurvivalVerdict =
  "SURVIVES" | "REGIME_DEPENDENT" | "UNSTABLE" | "INSUFFICIENT";

/** The quarter (spec Phase 9): does each finding survive regimes, and months? */
export interface QuarterlyAnswers {
  pairs: {
    patternId: string;
    strategyType: string;
    verdict: SurvivalVerdict;
    /** Why, in words — the rule that decided it. */
    because: string;
    byRegime: Record<string, { n: number; expectancy: number | null }>;
    byMonth: Record<string, { n: number; expectancy: number | null }>;
  }[];
}

/**
 * A pair SURVIVES when every regime holding enough of its Trades shows the
 * same sign of expectancy, and so does every month holding enough. Two
 * regimes disagreeing make it REGIME_DEPENDENT; a month disagreeing with
 * them makes it UNSTABLE; fewer than two regimes with enough Trades leave it
 * INSUFFICIENT — one regime cannot show survival across regimes.
 */
export function quarterlyAnswers(
  quarter: Aggregate,
  months: Readonly<Record<string, Aggregate>>,
  t: Thresholds = THRESHOLDS,
): QuarterlyAnswers {
  const out: QuarterlyAnswers["pairs"] = [];
  for (const p of pooled(quarter).filter((x) => x.trades.n > 0)) {
    const byRegime: Record<string, { n: number; expectancy: number | null }> =
      {};
    for (const r of quarter.pairs.filter(
      (x) =>
        x.patternId === p.patternId &&
        x.strategyType === p.strategyType &&
        x.regime !== ALL,
    ))
      byRegime[r.regime] = { n: r.trades.n, expectancy: r.trades.expectancy };
    const byMonth: Record<string, { n: number; expectancy: number | null }> =
      {};
    for (const [month, agg] of Object.entries(months).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const m = pooled(agg).find(
        (x) => x.patternId === p.patternId && x.strategyType === p.strategyType,
      );
      byMonth[month] = {
        n: m?.trades.n ?? 0,
        expectancy: m?.trades.expectancy ?? null,
      };
    }
    const regimeSigns = Object.values(byRegime)
      .filter((r) => r.n >= t.minRegimeTrades)
      .map((r) => sign(r.expectancy));
    const monthSigns = Object.values(byMonth)
      .filter((m) => m.n >= t.minMonthTrades)
      .map((m) => sign(m.expectancy));
    let verdict: SurvivalVerdict;
    let because: string;
    if (regimeSigns.length < 2) {
      verdict = "INSUFFICIENT";
      because = `${String(regimeSigns.length)} regime(s) with at least ${String(t.minRegimeTrades)} Trades; survival across regimes needs two`;
    } else if (new Set(regimeSigns).size > 1) {
      verdict = "REGIME_DEPENDENT";
      because = "expectancy changes sign between regimes";
    } else if (monthSigns.some((s) => s !== regimeSigns[0])) {
      verdict = "UNSTABLE";
      because = `a month with at least ${String(t.minMonthTrades)} Trades disagrees with the regimes' sign`;
    } else {
      verdict = "SURVIVES";
      because = `the same sign in ${String(regimeSigns.length)} regimes and ${String(monthSigns.length)} months with enough Trades`;
    }
    out.push({
      patternId: p.patternId,
      strategyType: p.strategyType,
      verdict,
      because,
      byRegime,
      byMonth,
    });
  }
  return { pairs: out };
}
