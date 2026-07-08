import type { Bar, Indicator } from "./types.js";

export interface EmaState {
  ema: number | null;
  seedSum: number;
  seedCount: number;
}

/**
 * Exponential Moving Average (plan/16 §2). `EMA = α·C + (1−α)·EMA_prev`,
 * `α = 2/(N+1)`, **seeded with SMA(N)** over the first N closes — the seeding
 * rule is why warm-up exists (plan/18 §4): an EMA folded from too few bars is
 * a confidently wrong number.
 */
export function ema(period: number): Indicator<EmaState> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`ema period must be a positive integer, got ${period}`);
  }
  const alpha = 2 / (period + 1);
  const key = `ema${period}`;
  return {
    key,
    sessionAnchored: false,
    warmupBars: period,
    init: () => ({ ema: null, seedSum: 0, seedCount: 0 }),
    fold(state, bar: Bar) {
      if (state.ema === null) {
        state.seedSum += bar.close;
        state.seedCount += 1;
        if (state.seedCount === period) {
          state.ema = state.seedSum / period; // SMA seed (plan/16 §2)
        }
      } else {
        state.ema = alpha * bar.close + (1 - alpha) * state.ema;
      }
      return state;
    },
    read: (state) => (state.ema === null ? null : { [key]: state.ema }),
    ready: (state) => state.ema !== null,
  };
}
