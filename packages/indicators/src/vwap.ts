import type { Bar, Indicator } from "./types.js";

export interface VwapState {
  pvSum: number; // Σ (typical price × volume)
  vSum: number; // Σ volume
}

/**
 * Volume-Weighted Average Price (plan/16 §4), **session-anchored**: typical
 * price `TP = (H+L+C)/3`, `VWAP = Σ(TP·V) / ΣV` accumulated from the session
 * open. `sessionAnchored: true` tells the Indicator Engine to reset it on
 * MARKET_OPEN (plan/18 §5) — carrying accumulation across sessions would
 * destroy its meaning ("the average price paid *today*", plan/16 §4). No
 * cross-day warm-up (`warmupBars: 0`); it's not ready until real volume prints.
 */
export function vwap(): Indicator<VwapState> {
  const key = "vwap";
  return {
    key,
    sessionAnchored: true,
    warmupBars: 0,
    init: () => ({ pvSum: 0, vSum: 0 }),
    fold(state, bar: Bar) {
      const typical = (bar.high + bar.low + bar.close) / 3;
      state.pvSum += typical * bar.volume;
      state.vSum += bar.volume;
      return state;
    },
    read: (state) =>
      state.vSum > 0 ? { [key]: state.pvSum / state.vSum } : null,
    ready: (state) => state.vSum > 0,
  };
}
