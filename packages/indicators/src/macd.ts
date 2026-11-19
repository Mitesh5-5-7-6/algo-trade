import { ema, type EmaState } from "./ema.js";
import type { Bar, Indicator } from "./types.js";

export interface MacdState {
  fast: EmaState;
  slow: EmaState;
  /** The signal line: an EMA of the MACD line, seeded once the line exists. */
  signal: EmaState;
  macd: number | null;
}

/**
 * MACD (operator request 2026-11-18): the fast EMA of the close less the slow
 * one, its signal line an EMA of that difference, and the histogram, line
 * less signal. Each EMA is the production `ema` fold, SMA-seeded.
 *
 * Keys: `macd{fast}_{slow}_{signal}` (the line), and the same with `signal`
 * and `hist`. Ready once the signal line has seeded.
 */
export function macd(fast = 12, slow = 26, signal = 9): Indicator<MacdState> {
  if (!(fast < slow))
    throw new Error(
      `macd fast period must be shorter than slow, got ${String(fast)} and ${String(slow)}`,
    );
  const fastEma = ema(fast);
  const slowEma = ema(slow);
  const signalEma = ema(signal);
  const key = `macd${String(fast)}_${String(slow)}_${String(signal)}`;
  return {
    key,
    sessionAnchored: false,
    warmupBars: slow + signal - 1,
    init: () => ({
      fast: fastEma.init(),
      slow: slowEma.init(),
      signal: signalEma.init(),
      macd: null,
    }),
    fold(state, bar: Bar) {
      state.fast = fastEma.fold(state.fast, bar);
      state.slow = slowEma.fold(state.slow, bar);
      if (state.fast.ema === null || state.slow.ema === null) return state;
      state.macd = state.fast.ema - state.slow.ema;
      // The signal EMA folds the MACD line as if it were a close.
      state.signal = signalEma.fold(state.signal, {
        ...bar,
        close: state.macd,
      });
      return state;
    },
    read: (state) =>
      state.macd === null || state.signal.ema === null
        ? null
        : {
            [key]: state.macd,
            [`${key}signal`]: state.signal.ema,
            [`${key}hist`]: state.macd - state.signal.ema,
          },
    ready: (state) => state.signal.ema !== null,
  };
}
