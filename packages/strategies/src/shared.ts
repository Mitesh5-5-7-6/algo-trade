import type { Candle, StrategyVerdict } from "@neelkanth/core";

/** Clamp to the confidence range [0, 1] (plan/15 §6). */
export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** A HOLD verdict — the strategy looked and chose inaction (plan/15 §4). */
export const hold = (reason: string): StrategyVerdict => ({
  side: "HOLD",
  confidence: 0,
  reason,
});

/** Lowest low over the last `lookback` bars (the recent swing low), or null. */
export function recentLow(
  candles: readonly Candle[],
  lookback: number,
): number | null {
  if (candles.length === 0) return null;
  return candles
    .slice(-lookback)
    .reduce((m, c) => Math.min(m, c.low), Number.POSITIVE_INFINITY);
}

/** Highest high over the last `lookback` bars (the recent swing high), or null. */
export function recentHigh(
  candles: readonly Candle[],
  lookback: number,
): number | null {
  if (candles.length === 0) return null;
  return candles
    .slice(-lookback)
    .reduce((m, c) => Math.max(m, c.high), Number.NEGATIVE_INFINITY);
}
