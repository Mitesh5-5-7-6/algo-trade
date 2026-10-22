import {
  intervalMs,
  istDateKey,
  type CandleInterval,
  type PatternOccurrence,
  type Signal,
  type Trade,
} from "@neelkanth/core";
import type { ReplayTrail } from "../golden/pipeline.js";
import { regimeAt, type Regime, type RegimeTimeline } from "./regime.js";

/** Bumped whenever what a relation means changes (Phase 6 D5). */
export const ATTRIBUTION_MODEL_VERSION = "1";

/** The attribution model a run declares on its manifest. */
export interface AttributionModel {
  version: string;
  /**
   * How many bars after the pattern's bar a decision still counts as a
   * response: 0 means "decided on the bar the pattern completed".
   */
  windowBars: number;
}

export const DEFAULT_ATTRIBUTION_MODEL: AttributionModel = {
  version: ATTRIBUTION_MODEL_VERSION,
  windowBars: 0,
};

/**
 * What a strategy did about one occurrence (design D5), by precedence:
 *
 * - `ENTERED` — it opened a Trade decided in the window, same session;
 * - `SIGNALLED` — it proposed an entry in the window, but no Trade opened;
 * - `HOLDING` — it was already in a Trade open across the pattern's bar;
 * - `FLAT` — none of these: it did not act on it.
 */
export type Relation = "ENTERED" | "SIGNALLED" | "HOLDING" | "FLAT";

/** One strategy, replayed alone on one symbol (D2). */
export interface StrategyRun {
  strategyType: string;
  symbol: string;
  trail: ReplayTrail;
}

export interface Attribution {
  patternId: string;
  detectorVersion: string;
  symbol: string;
  /** The pattern's bar. */
  ts: number;
  /** The regime in force at that bar. */
  regime: Regime;
  strategyType: string;
  relation: Relation;
  /** The Trade it entered, for `ENTERED`, or the one it held, for `HOLDING`. */
  tradeId?: string;
}

/** The bar a Trade's entry was decided on — what a pattern joins to. */
export function entryBarOf(trade: Trade): number {
  const bar = trade.dataProvenance?.barTs;
  if (bar === undefined)
    throw new Error(
      `trade ${trade.tradeId} has no entry bar — it cannot be attributed`,
    );
  return bar;
}

const isEntrySignal = (s: Signal): boolean =>
  s.side !== "HOLD" && s.exitReason === undefined;

/**
 * Attribute every occurrence to every strategy run on its symbol.
 *
 * Only forward to the decision, never back: a Trade decided before the
 * pattern's bar is not a response to it, however close. The window ends
 * at the session's close — tomorrow's entry is not a response to today's
 * bar. The labels (pattern, regime) use bars at or before the pattern's;
 * the response is the strategy's own replayed decision (Phase 4 D7).
 */
export function attribute(
  occurrences: readonly PatternOccurrence[],
  runs: readonly StrategyRun[],
  timeline: RegimeTimeline,
  interval: CandleInterval,
  model: AttributionModel = DEFAULT_ATTRIBUTION_MODEL,
): Attribution[] {
  const barMs = intervalMs(interval);
  const out: Attribution[] = [];
  for (const run of runs) {
    const trades = [...run.trail.trades].sort(
      (a, b) => entryBarOf(a) - entryBarOf(b) || cmp(a.tradeId, b.tradeId),
    );
    const entrySignals = run.trail.signals
      .filter(isEntrySignal)
      .map((s) => s.dataProvenance?.barTs ?? s.ts);
    for (const o of occurrences) {
      if (o.symbol !== run.symbol) continue;
      const end = o.ts + model.windowBars * barMs;
      const day = istDateKey(o.ts);
      const inWindow = (bar: number): boolean =>
        bar >= o.ts && bar <= end && istDateKey(bar) === day;

      const entered = trades.find((t) => inWindow(entryBarOf(t)));
      const held =
        entered === undefined
          ? trades.find(
              (t) =>
                entryBarOf(t) < o.ts &&
                (t.exitTime === undefined || t.exitTime > o.ts),
            )
          : undefined;
      const relation: Relation =
        entered !== undefined
          ? "ENTERED"
          : entrySignals.some(inWindow)
            ? "SIGNALLED"
            : held !== undefined
              ? "HOLDING"
              : "FLAT";
      const tradeId = (entered ?? held)?.tradeId;
      out.push({
        patternId: o.patternId,
        detectorVersion: o.detectorVersion,
        symbol: o.symbol,
        ts: o.ts,
        regime: regimeAt(timeline, o.ts),
        strategyType: run.strategyType,
        relation,
        ...(tradeId === undefined || relation === "SIGNALLED"
          ? {}
          : { tradeId }),
      });
    }
  }
  return out;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
