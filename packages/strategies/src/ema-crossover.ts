import { z } from "zod";
import { CandleIntervalSchema, type StrategyVerdict } from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold, recentHigh, recentLow } from "./shared.js";

/**
 * EMA Crossover — trend following on the crossing of two EMAs (plan/16 §2).
 * Buy on a fast-over-slow cross up (closed bar); the opposite cross exits a
 * long or, if enabled, enters a short. Its known failure mode is whipsaw in
 * ranges (plan/16 §2 Weaknesses) — which is exactly what its trap test covers.
 */
export const EmaCrossoverParamsSchema = z
  .object({
    fast: z.number().int().positive().default(9),
    slow: z.number().int().positive().default(21),
    interval: CandleIntervalSchema.default("5m"),
    /** Reward target as a multiple of risk (R). */
    targetR: z.number().positive().default(2),
    quantity: z.number().int().positive().default(1),
    allowShort: z.boolean().default(false),
    /** Bars scanned for the swing low/high that anchors the stop. */
    swingLookback: z.number().int().positive().default(10),
  })
  .refine((p) => p.fast < p.slow, {
    message: "fast period must be < slow period",
  });

export type EmaCrossoverParams = z.infer<typeof EmaCrossoverParamsSchema>;

/** Per-instance state: config + the previous bar's EMAs, to detect the cross. */
export interface EmaCrossoverState {
  params: EmaCrossoverParams;
  prevFast: number | null;
  prevSlow: number | null;
}

export const emaCrossover: StrategyDefinition<
  EmaCrossoverParams,
  EmaCrossoverState
> = {
  type: "EMA_CROSSOVER",
  paramsSchema: EmaCrossoverParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) => [
    { kind: "ema", period: p.fast },
    { kind: "ema", period: p.slow },
  ],
  warmupBars: (p) => p.slow,
  init: (params) => ({ params, prevFast: null, prevSlow: null }),
  analyze(context, state): StrategyVerdict {
    const p = state.params;
    const fast = context.indicators[`ema${p.fast}`];
    const slow = context.indicators[`ema${p.slow}`];
    if (fast === undefined || slow === undefined) {
      return hold("EMAs not ready");
    }

    const { prevFast, prevSlow } = state;
    state.prevFast = fast;
    state.prevSlow = slow;
    if (prevFast === null || prevSlow === null) {
      return hold("seeding cross state"); // need a prior bar to detect a cross
    }

    const close = context.candle.close;
    // Confidence grows with the separation at the cross (plan/16 §2) — bounded.
    const confidence = clamp01(0.4 + (Math.abs(fast - slow) / close) * 300);
    const crossUp = prevFast <= prevSlow && fast > slow;
    const crossDown = prevFast >= prevSlow && fast < slow;

    if (crossUp) {
      // Stop below the recent swing low; fallback below the slow EMA (plan/16 §2).
      let stopLoss = Math.min(
        recentLow(context.candles, p.swingLookback) ?? slow,
        slow,
      );
      if (stopLoss >= close) stopLoss = close * 0.995;
      const risk = close - stopLoss;
      return {
        side: "BUY",
        confidence,
        qtyProposal: p.quantity,
        stopLoss,
        target: close + p.targetR * risk,
        reason: `fast EMA ${p.fast} crossed above slow EMA ${p.slow}`,
      };
    }

    if (crossDown) {
      // Opposite cross closes a long (plan/16 §2), regardless of allowShort.
      if (context.position !== null && context.position.side === "LONG") {
        return {
          side: "SELL",
          confidence: Math.max(confidence, 0.6),
          qtyProposal: context.position.qty,
          reason: `fast EMA ${p.fast} crossed below slow EMA ${p.slow} — exit long`,
        };
      }
      if (p.allowShort && context.position === null) {
        let stopLoss = Math.max(
          recentHigh(context.candles, p.swingLookback) ?? slow,
          slow,
        );
        if (stopLoss <= close) stopLoss = close * 1.005;
        const risk = stopLoss - close;
        return {
          side: "SELL",
          confidence,
          qtyProposal: p.quantity,
          stopLoss,
          target: close - p.targetR * risk,
          reason: `fast EMA ${p.fast} crossed below slow EMA ${p.slow} — short`,
        };
      }
    }

    return hold("no cross");
  },
};
