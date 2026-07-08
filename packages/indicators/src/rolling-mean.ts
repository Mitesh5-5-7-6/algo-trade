import type { Bar, Indicator } from "./types.js";

export interface RollingMeanState {
  buf: number[];
  idx: number;
  count: number;
  sum: number;
}

type Source = "close" | "volume";

/**
 * A rolling arithmetic mean over the last N bars (plan/16 §8, plan/18 §3),
 * O(1) per bar via a running sum + ring buffer. Backs both SMA (on close) and
 * the volume baseline (`avgVol`). Not ready until N bars have accumulated.
 */
function rollingMean(
  period: number,
  source: Source,
  key: string,
): Indicator<RollingMeanState> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`period must be a positive integer, got ${period}`);
  }
  const pick = (bar: Bar): number =>
    source === "volume" ? bar.volume : bar.close;
  return {
    key,
    sessionAnchored: false,
    warmupBars: period,
    init: () => ({ buf: [], idx: 0, count: 0, sum: 0 }),
    fold(state, bar: Bar) {
      const value = pick(bar);
      if (state.count < period) {
        state.buf.push(value);
        state.sum += value;
        state.count += 1;
      } else {
        // Evict the oldest (at idx), insert the newest, advance the ring.
        state.sum -= state.buf[state.idx] ?? 0;
        state.buf[state.idx] = value;
        state.sum += value;
        state.idx = (state.idx + 1) % period;
      }
      return state;
    },
    read: (state) =>
      state.count >= period ? { [key]: state.sum / period } : null,
    ready: (state) => state.count >= period,
  };
}

/** Simple Moving Average of close over N bars. */
export function sma(period: number): Indicator<RollingMeanState> {
  return rollingMean(period, "close", `sma${period}`);
}

/** Average traded volume over N bars — the breakout volume baseline (plan/16 §8). */
export function avgVolume(period: number): Indicator<RollingMeanState> {
  return rollingMean(period, "volume", `avgvol${period}`);
}
