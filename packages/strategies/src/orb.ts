import { z } from "zod";
import { CandleIntervalSchema, type StrategyVerdict } from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold } from "./shared.js";

/**
 * Opening Range Breakout (plan/16 §5): let the first K minutes define the
 * range, then trade the close beyond it (close-based, to filter wick fakes).
 * At most one entry per direction per day. Its tax is false breakouts — break,
 * trigger, collapse back into the range (plan/16 §5 Weaknesses); the trap test
 * covers a fake that never closes beyond the range.
 *
 * The opening range is built from live bars using `session.minutesSinceOpen`
 * (plan/15 §3); a new session is detected when that value drops, resetting the
 * range and the per-direction one-shot flags.
 */
export const OrbParamsSchema = z.object({
  /** Opening-range window in minutes (plan/16 §5, default 15). */
  rangeMinutes: z.number().int().positive().default(15),
  interval: CandleIntervalSchema.default("5m"),
  /** Measured-move target as a multiple of the range (plan/16 §5). */
  targetMultiple: z.number().positive().default(1),
  quantity: z.number().int().positive().default(1),
  allowShort: z.boolean().default(true),
  /** Optional volume confirmation: require V ≥ k · avgVol (plan/16 §5). */
  volumeMultiple: z.number().positive().optional(),
  avgVolPeriod: z.number().int().positive().default(20),
  /** Optional minimum range floor — screens out noise-level ranges (plan/16 §5). */
  minRange: z.number().nonnegative().optional(),
});

export type OrbParams = z.infer<typeof OrbParamsSchema>;

export interface OrbState {
  params: OrbParams;
  sessionMarker: number | null;
  orHigh: number | null;
  orLow: number | null;
  enteredUp: boolean;
  enteredDown: boolean;
}

export const orb: StrategyDefinition<OrbParams, OrbState> = {
  type: "ORB",
  paramsSchema: OrbParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) =>
    p.volumeMultiple === undefined
      ? []
      : [{ kind: "avgVolume", period: p.avgVolPeriod }],
  warmupBars: (p) => (p.volumeMultiple === undefined ? 0 : p.avgVolPeriod),
  init: (params) => ({
    params,
    sessionMarker: null,
    orHigh: null,
    orLow: null,
    enteredUp: false,
    enteredDown: false,
  }),
  analyze(context, state): StrategyVerdict {
    const p = state.params;
    const mso = context.session.minutesSinceOpen;

    // New session (minutesSinceOpen dropped, or first bar) → reset (plan/16 §5).
    if (state.sessionMarker === null || mso < state.sessionMarker) {
      state.orHigh = null;
      state.orLow = null;
      state.enteredUp = false;
      state.enteredDown = false;
    }
    state.sessionMarker = mso;

    const candle = context.candle;

    // Still inside the opening-range window: accumulate the range, no signal.
    if (mso <= p.rangeMinutes) {
      state.orHigh =
        state.orHigh === null
          ? candle.high
          : Math.max(state.orHigh, candle.high);
      state.orLow =
        state.orLow === null ? candle.low : Math.min(state.orLow, candle.low);
      return hold("building opening range");
    }
    if (state.orHigh === null || state.orLow === null) {
      return hold("no opening range for this session");
    }

    const range = state.orHigh - state.orLow;
    if (p.minRange !== undefined && range < p.minRange) {
      return hold("opening range below floor");
    }

    // Optional volume gate (plan/16 §5).
    if (p.volumeMultiple !== undefined) {
      const avgVol = context.indicators[`avgvol${p.avgVolPeriod}`];
      if (avgVol === undefined) return hold("avgVol not ready");
      if (candle.volume < p.volumeMultiple * avgVol) {
        return hold("breakout volume below threshold");
      }
    }

    const midpoint = (state.orHigh + state.orLow) / 2; // default stop (plan/16 §5)

    if (!state.enteredUp && candle.close > state.orHigh) {
      state.enteredUp = true;
      const margin = (candle.close - state.orHigh) / range;
      return {
        side: "BUY",
        confidence: clamp01(0.5 + margin),
        qtyProposal: p.quantity,
        stopLoss: midpoint,
        target: candle.close + p.targetMultiple * range,
        reason: "close above the opening-range high",
      };
    }

    if (p.allowShort && !state.enteredDown && candle.close < state.orLow) {
      state.enteredDown = true;
      const margin = (state.orLow - candle.close) / range;
      return {
        side: "SELL",
        confidence: clamp01(0.5 + margin),
        qtyProposal: p.quantity,
        stopLoss: midpoint,
        target: candle.close - p.targetMultiple * range,
        reason: "close below the opening-range low",
      };
    }

    return hold("no breakout");
  },
};
