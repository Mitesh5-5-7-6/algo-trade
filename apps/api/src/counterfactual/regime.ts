import { createHash } from "node:crypto";
import type { Candle, MarketBias } from "@neelkanth/core";
import { ema } from "@neelkanth/indicators";

/** Bumped whenever what a regime label means changes (Phase 6 D4). */
export const REGIME_MODEL_VERSION = "1";

/** The regime model a run declares on its manifest. */
export interface RegimeModel {
  version: string;
  kind: "INDEX_TREND";
  /** The one index whose trend labels every symbol: a regime is the market's. */
  symbol: string;
  emaPeriod: number;
}

export const DEFAULT_REGIME_MODEL: RegimeModel = {
  version: REGIME_MODEL_VERSION,
  kind: "INDEX_TREND",
  symbol: "NSE:NIFTY50-INDEX",
  emaPeriod: 21,
};

export type Regime = MarketBias;

/** The regime at each regime-index bar's close, oldest first. */
export interface RegimeTimeline {
  readonly model: RegimeModel;
  readonly ts: readonly number[];
  readonly regime: readonly Regime[];
}

/**
 * Label the market's regime at every bar of the regime index (design D4).
 *
 * The index's close against its EMA(21) — the trend half of the system's own
 * market view, through the shared indicator fold — `BULLISH` above, `BEARISH`
 * below, `NEUTRAL` at the line or while the EMA is not yet warm. Folded
 * continuously across sessions, as the live trend is.
 *
 * **Volume-free, deliberately.** The market view confirms trend with VWAP, and
 * on the stored index year that VWAP is computed from `SUSPECT` volume (Phase
 * 5 D3; design finding F1). A regime label is a research conclusion, so it
 * draws none from volume.
 *
 * Each label uses only bars at or before its own (spec §5.4); bars must be
 * one series in strictly ascending order, or it refuses.
 */
export function regimeTimeline(
  candles: readonly Candle[],
  model: RegimeModel = DEFAULT_REGIME_MODEL,
): RegimeTimeline {
  const fold = ema(model.emaPeriod);
  const state = fold.init();
  const ts: number[] = [];
  const regime: Regime[] = [];
  let previous = -Infinity;
  for (const bar of candles) {
    if (bar.symbol !== model.symbol)
      throw new Error(
        `regime of ${model.symbol} was given a ${bar.symbol} bar`,
      );
    if (bar.ts <= previous)
      throw new Error(
        `regime of ${model.symbol}: bars must be strictly ascending by ts`,
      );
    previous = bar.ts;
    fold.fold(state, bar);
    const trend = fold.ready(state) ? fold.read(state)?.[fold.key] : undefined;
    ts.push(bar.ts);
    regime.push(
      trend === undefined
        ? "NEUTRAL"
        : bar.close > trend
          ? "BULLISH"
          : bar.close < trend
            ? "BEARISH"
            : "NEUTRAL",
    );
  }
  return { model, ts, regime };
}

/**
 * The regime in force at bar `ts` of any symbol: the label of the latest
 * regime-index bar at or before it — never a later one — or `NEUTRAL` when
 * none exists yet.
 */
export function regimeAt(timeline: RegimeTimeline, ts: number): Regime {
  let lo = 0;
  let hi = timeline.ts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((timeline.ts[mid] ?? Infinity) <= ts) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? "NEUTRAL" : (timeline.regime[found] ?? "NEUTRAL");
}

/** sha256 of a timeline's labels — what its version pin compares. */
export function regimeFingerprint(timeline: RegimeTimeline): string {
  const lines = timeline.ts.map(
    (t, i) => `${String(t)}:${timeline.regime[i] ?? "?"}`,
  );
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
