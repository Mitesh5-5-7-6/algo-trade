import type { Bar, Indicator } from "./types.js";

export interface BollingerState {
  closes: number[];
}

/**
 * Bollinger bands (operator request 2026-11-18): the mean of the last
 * `period` closes, and bands `stdDev` population standard deviations either
 * side of it.
 *
 * Keys: `bb{period}x{stdDev}` (the middle), and the same with `upper` and
 * `lower`. Ready once `period` closes are held.
 */
export function bollinger(period = 20, stdDev = 2): Indicator<BollingerState> {
  if (!Number.isInteger(period) || period < 2)
    throw new Error(
      `bollinger period must be an integer of 2 or more, got ${String(period)}`,
    );
  if (!(stdDev > 0))
    throw new Error(`bollinger width must be positive, got ${String(stdDev)}`);
  const key = `bb${String(period)}x${String(stdDev)}`;
  return {
    key,
    sessionAnchored: false,
    warmupBars: period,
    init: () => ({ closes: [] }),
    fold(state, bar: Bar) {
      state.closes.push(bar.close);
      if (state.closes.length > period) state.closes.shift();
      return state;
    },
    read: (state) => {
      if (state.closes.length < period) return null;
      const mean = state.closes.reduce((a, b) => a + b, 0) / period;
      const variance =
        state.closes.reduce((a, c) => a + (c - mean) ** 2, 0) / period;
      const width = stdDev * Math.sqrt(variance);
      return {
        [key]: mean,
        [`${key}upper`]: mean + width,
        [`${key}lower`]: mean - width,
      };
    },
    ready: (state) => state.closes.length >= period,
  };
}
