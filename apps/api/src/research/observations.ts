import { istDateKey, isWeekendIST, type Candle } from "@neelkanth/core";
import type { Relation } from "../counterfactual/attribution.js";
import { regimeAt, type Regime } from "../counterfactual/regime.js";
import type { ReplayExclusion } from "../replay/run.js";
import { sampleStdDev } from "../validation/stats.js";
import type { DayRun } from "./day.js";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** One instrument's day, as features (Phase 8 D3). */
export interface DayFeatures {
  symbol: string;
  bars: number;
  open: number;
  high: number;
  low: number;
  close: number;
  range: number;
  /** close ÷ open − 1. */
  returnPct: number;
  /** open ÷ the prior session's close − 1; null when the run holds no prior session. */
  gapPct: number | null;
  /** Sample spread of bar-to-bar close returns — not annualised. */
  realisedVolatility: number | null;
  /** A weekend date with bars: Budget, Muhurat. */
  specialSession: boolean;
  regimeAtClose: Regime;
  sources: Record<string, number>;
  ingestionVersions: number[];
  /** Bars by volume quality; a bar silent about it counts as REAL (CandleSchema). */
  volumeQuality: Record<string, number>;
}

/** One occurrence, compared across every strategy on its symbol (spec Phase 8). */
export interface PatternObservation {
  patternId: string;
  detectorVersion: string;
  ts: number;
  direction: string;
  evidence: Record<string, number>;
  marketContext: Record<string, unknown>;
  regime: Regime;
  strategies: Record<string, { relation: Relation; tradeKey?: string }>;
}

/** One strategy's day on one instrument, or why it had none (Phase 8 D3). */
export type StrategyObservation =
  | {
      type: string;
      eligible: true;
      strategyVersion: string;
      /** Entry and strategy-exit proposals; HOLDs and mechanical exits counted apart. */
      actionable: number;
      holds: number;
      mechanicalExits: number;
      approved: number;
      /** Blocked proposals by the risk check that refused them. */
      blocked: Record<string, number>;
      trades: number;
      wins: number;
      net: number;
    }
  | { type: string; eligible: false; exclusion: ReplayExclusion };

/** The day's bars for one symbol, in order. */
function dayBars(day: DayRun, symbol: string): Candle[] {
  return day.bars.filter(
    (b) => b.symbol === symbol && istDateKey(b.ts) === day.date,
  );
}

export function dayFeatures(day: DayRun, symbol: string): DayFeatures {
  const bars = dayBars(day, symbol);
  const first = bars[0];
  const last = bars.at(-1);
  if (first === undefined || last === undefined)
    throw new Error(`${symbol} has no bars on ${day.date}`);
  const prior = day.bars
    .filter((b) => b.symbol === symbol && istDateKey(b.ts) < day.date)
    .at(-1);
  const returns = bars
    .slice(1)
    .map((b, i) => b.close / (bars[i]?.close ?? b.close) - 1);
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  const count = (key: (b: Candle) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const b of bars) out[key(b)] = (out[key(b)] ?? 0) + 1;
    return Object.fromEntries(
      Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  };
  return {
    symbol,
    bars: bars.length,
    open: first.open,
    high,
    low,
    close: last.close,
    range: round6(high - low),
    returnPct: round6(last.close / first.open - 1),
    gapPct: prior === undefined ? null : round6(first.open / prior.close - 1),
    realisedVolatility:
      returns.length < 2 ? null : round6(sampleStdDev(returns)),
    specialSession: isWeekendIST(day.date),
    regimeAtClose: regimeAt(day.evaluation.timeline, last.ts),
    sources: count((b) => b.source),
    ingestionVersions: [
      ...new Set(
        bars
          .map((b) => b.ingestionVersion)
          .filter((v): v is number => v !== undefined),
      ),
    ].sort((a, b) => a - b),
    volumeQuality: count((b) => b.volumeQuality ?? "REAL"),
  };
}

/** The evidence key a relation points at — the same shape as `TradeEvidence.key`. */
const keyOf = (strategyType: string, symbol: string, tradeId: string): string =>
  [strategyType, symbol, tradeId].join("|");

export function patternObservations(
  day: DayRun,
  symbol: string,
): PatternObservation[] {
  return day.occurrences
    .filter((o) => o.symbol === symbol)
    .map((o) => {
      const strategies: PatternObservation["strategies"] = {};
      let regime: Regime = regimeAt(day.evaluation.timeline, o.ts);
      for (const a of day.attributions) {
        if (
          a.symbol !== symbol ||
          a.ts !== o.ts ||
          a.patternId !== o.patternId ||
          a.detectorVersion !== o.detectorVersion
        )
          continue;
        regime = a.regime;
        strategies[a.strategyType] = {
          relation: a.relation,
          ...(a.tradeId === undefined
            ? {}
            : { tradeKey: keyOf(a.strategyType, symbol, a.tradeId) }),
        };
      }
      return {
        patternId: o.patternId,
        detectorVersion: o.detectorVersion,
        ts: o.ts,
        direction: o.direction,
        evidence: o.evidence,
        marketContext: o.marketContext,
        regime,
        strategies,
      };
    });
}

export function strategyObservations(
  day: DayRun,
  symbol: string,
): StrategyObservation[] {
  return day.evaluation.manifest.strategies
    .filter((s) => s.symbol === symbol)
    .map((s): StrategyObservation => {
      if (!s.eligible)
        return { type: s.type, eligible: false, exclusion: s.exclusion };
      const sd = day.strategyDays.find(
        (d) => d.strategyType === s.type && d.symbol === symbol,
      );
      const run = day.evaluation.runs.find(
        (r) => r.strategyType === s.type && r.symbol === symbol,
      );
      const signals = sd?.signals ?? [];
      const decided = new Map(
        (run?.trail.riskLogs ?? []).map((l) => [l.signalId, l]),
      );
      const actionable = signals.filter(
        (x) =>
          x.side !== "HOLD" &&
          (x.exitReason === undefined || x.exitReason === "STRATEGY_EXIT"),
      );
      const blocked: Record<string, number> = {};
      let approved = 0;
      for (const x of actionable) {
        const log = decided.get(x.signalId);
        if (log?.decision === "approved") approved += 1;
        else if (log !== undefined)
          blocked[log.failedCheck ?? "unknown"] =
            (blocked[log.failedCheck ?? "unknown"] ?? 0) + 1;
      }
      const trades = sd?.trades ?? [];
      return {
        type: s.type,
        eligible: true,
        strategyVersion: s.strategyVersion,
        actionable: actionable.length,
        holds: signals.filter((x) => x.side === "HOLD").length,
        mechanicalExits: signals.filter(
          (x) =>
            x.side !== "HOLD" &&
            x.exitReason !== undefined &&
            x.exitReason !== "STRATEGY_EXIT",
        ).length,
        approved,
        blocked: Object.fromEntries(
          Object.entries(blocked).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
        trades: trades.length,
        wins: trades.filter((t) => (t.netPnl ?? 0) > 0).length,
        net: round6(trades.reduce((n, t) => n + (t.netPnl ?? 0), 0)),
      };
    });
}
