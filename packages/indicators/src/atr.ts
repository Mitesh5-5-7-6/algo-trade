import type { Bar, Indicator } from "./types.js";

export interface AtrState {
  prevClose: number | null;
  seedSum: number;
  seedCount: number;
  atr: number | null;
}

/** True range (plan/16 §7): max(H−L, |H−C_prev|, |L−C_prev|). */
export function trueRange(bar: Bar, prevClose: number | null): number {
  const hl = bar.high - bar.low;
  if (prevClose === null) return hl;
  return Math.max(
    hl,
    Math.abs(bar.high - prevClose),
    Math.abs(bar.low - prevClose),
  );
}

/**
 * Average True Range, **Wilder smoothing** (plan/16 §7). Seeds with the mean
 * TR over the first N bars, then `ATR' = (ATR·(N−1) + TR)/N`. The volatility
 * measure SuperTrend's band is sized from (plan/16 §7).
 */
export function atr(period: number): Indicator<AtrState> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`atr period must be a positive integer, got ${period}`);
  }
  const key = `atr${period}`;
  return {
    key,
    sessionAnchored: false,
    warmupBars: period,
    init: () => ({ prevClose: null, seedSum: 0, seedCount: 0, atr: null }),
    fold(state, bar: Bar) {
      const tr = trueRange(bar, state.prevClose);
      state.prevClose = bar.close;
      if (state.atr === null) {
        state.seedSum += tr;
        state.seedCount += 1;
        if (state.seedCount === period) state.atr = state.seedSum / period;
      } else {
        state.atr = (state.atr * (period - 1) + tr) / period;
      }
      return state;
    },
    read: (state) => (state.atr === null ? null : { [key]: state.atr }),
    ready: (state) => state.atr !== null,
  };
}
