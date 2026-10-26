import type { Candle } from "@neelkanth/core";

/** The bars strictly before the decision bar, most recent `count` of them. */
export function priorBars(
  candles: readonly Candle[],
  count: number,
): readonly Candle[] {
  // `-1` excludes the decision bar itself. A "20-bar high" that includes the
  // bar being judged is not a breakout, it is a tautology.
  return candles.slice(Math.max(0, candles.length - 1 - count), -1);
}

/** Bars belonging to the first `minutes` of the session. */
export function openingRange(
  candles: readonly Candle[],
  sessionOpenTs: number,
  minutes: number,
): readonly Candle[] {
  const end = sessionOpenTs + minutes * 60_000;
  return candles.filter((bar) => bar.ts >= sessionOpenTs && bar.ts < end);
}

export const highestHigh = (bars: readonly Candle[]): number =>
  Math.max(...bars.map((bar) => bar.high));

export const lowestLow = (bars: readonly Candle[]): number =>
  Math.min(...bars.map((bar) => bar.low));

export const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
