import type { Bar, Indicator } from "./types.js";

export interface RsiState {
  prevClose: number | null;
  avgGain: number;
  avgLoss: number;
  seedGain: number;
  seedLoss: number;
  deltaCount: number;
  seeded: boolean;
}

/**
 * Relative Strength Index, **Wilder smoothing** (plan/16 §3). Seeds from the
 * mean gain/loss over the first N deltas, then folds each new delta with
 * Wilder's `avg' = (avg·(N−1) + x)/N`. Needs N+1 closes to produce the first
 * value — hence `warmupBars = N + 1`. `RSI = 100` when average loss is zero.
 */
export function rsi(period: number): Indicator<RsiState> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`rsi period must be a positive integer, got ${period}`);
  }
  const key = `rsi${period}`;
  return {
    key,
    sessionAnchored: false,
    warmupBars: period + 1,
    init: () => ({
      prevClose: null,
      avgGain: 0,
      avgLoss: 0,
      seedGain: 0,
      seedLoss: 0,
      deltaCount: 0,
      seeded: false,
    }),
    fold(state, bar: Bar) {
      if (state.prevClose === null) {
        state.prevClose = bar.close;
        return state; // first bar: no delta yet
      }
      const delta = bar.close - state.prevClose;
      state.prevClose = bar.close;
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;

      if (!state.seeded) {
        state.seedGain += gain;
        state.seedLoss += loss;
        state.deltaCount += 1;
        if (state.deltaCount === period) {
          state.avgGain = state.seedGain / period;
          state.avgLoss = state.seedLoss / period;
          state.seeded = true;
        }
      } else {
        state.avgGain = (state.avgGain * (period - 1) + gain) / period;
        state.avgLoss = (state.avgLoss * (period - 1) + loss) / period;
      }
      return state;
    },
    read(state) {
      if (!state.seeded) return null;
      if (state.avgLoss === 0) return { [key]: 100 };
      const rs = state.avgGain / state.avgLoss;
      return { [key]: 100 - 100 / (1 + rs) };
    },
    ready: (state) => state.seeded,
  };
}
