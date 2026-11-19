import { trueRange } from "./atr.js";
import type { Bar, Indicator } from "./types.js";

export interface SupertrendState {
  prevClose: number | null;
  seedSum: number;
  seedCount: number;
  atr: number | null;
  upper: number | null;
  lower: number | null;
  /** +1 up (price above the lower band), -1 down; null before the first. */
  direction: 1 | -1 | null;
}

/**
 * Supertrend (operator request 2026-11-18): bands at `multiplier` × ATR
 * (Wilder's, as `atr`) around the bar's midpoint, (high + low) / 2. A band
 * only tightens toward price while the trend holds; the direction flips when
 * the close crosses the band on the other side. Outputs the line — the lower
 * band in an uptrend, the upper in a downtrend — and the direction, +1 or -1.
 *
 * Keys: `supertrend{period}x{multiplier}` (the line) and the same with `dir`.
 */
export function supertrend(
  period = 10,
  multiplier = 3,
): Indicator<SupertrendState> {
  if (!Number.isInteger(period) || period < 1)
    throw new Error(
      `supertrend period must be a positive integer, got ${String(period)}`,
    );
  if (!(multiplier > 0))
    throw new Error(
      `supertrend multiplier must be positive, got ${String(multiplier)}`,
    );
  const key = `supertrend${String(period)}x${String(multiplier)}`;
  return {
    key,
    sessionAnchored: false,
    warmupBars: period,
    init: () => ({
      prevClose: null,
      seedSum: 0,
      seedCount: 0,
      atr: null,
      upper: null,
      lower: null,
      direction: null,
    }),
    fold(state, bar: Bar) {
      const tr = trueRange(bar, state.prevClose);
      const prevClose = state.prevClose;
      state.prevClose = bar.close;
      if (state.atr === null) {
        state.seedSum += tr;
        state.seedCount += 1;
        if (state.seedCount < period) return state;
        state.atr = state.seedSum / period;
      } else {
        state.atr = (state.atr * (period - 1) + tr) / period;
      }
      const mid = (bar.high + bar.low) / 2;
      const basicUpper = mid + multiplier * state.atr;
      const basicLower = mid - multiplier * state.atr;
      // A band moves only toward price while the previous close respected it.
      const upper =
        state.upper === null ||
        basicUpper < state.upper ||
        (prevClose !== null && prevClose > state.upper)
          ? basicUpper
          : state.upper;
      const lower =
        state.lower === null ||
        basicLower > state.lower ||
        (prevClose !== null && prevClose < state.lower)
          ? basicLower
          : state.lower;
      if (state.direction === null) {
        state.direction = bar.close >= mid ? 1 : -1;
      } else if (state.direction === 1 && bar.close < lower) {
        state.direction = -1;
      } else if (state.direction === -1 && bar.close > upper) {
        state.direction = 1;
      }
      state.upper = upper;
      state.lower = lower;
      return state;
    },
    read: (state) =>
      state.direction === null || state.upper === null || state.lower === null
        ? null
        : {
            [key]: state.direction === 1 ? state.lower : state.upper,
            [`${key}dir`]: state.direction,
          },
    ready: (state) => state.direction !== null,
  };
}
