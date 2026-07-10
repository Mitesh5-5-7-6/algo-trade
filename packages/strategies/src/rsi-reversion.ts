import { z } from "zod";
import { CandleIntervalSchema, type StrategyVerdict } from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold, recentHigh, recentLow } from "./shared.js";

/**
 * RSI mean reversion (plan/16 §3): buy the **re-cross up** through oversold —
 * not the raw level, because buying while RSI is still falling is catching a
 * falling knife (plan/16 §3). The re-cross demands the first evidence of
 * recovery. Its trap is a strong trend where RSI stays pinned oversold; that
 * is what its trap test guards.
 */
export const RsiReversionParamsSchema = z.object({
  period: z.number().int().positive().default(14),
  oversold: z.number().default(30),
  overbought: z.number().default(70),
  interval: CandleIntervalSchema.default("5m"),
  /** Mean-reversion targets are deliberately modest (plan/16 §3). */
  targetR: z.number().positive().default(1.5),
  quantity: z.number().int().positive().default(1),
  allowShort: z.boolean().default(false),
  swingLookback: z.number().int().positive().default(10),
});

export type RsiReversionParams = z.infer<typeof RsiReversionParamsSchema>;

export interface RsiReversionState {
  params: RsiReversionParams;
  prevRsi: number | null;
}

export const rsiReversion: StrategyDefinition<
  RsiReversionParams,
  RsiReversionState
> = {
  type: "RSI",
  paramsSchema: RsiReversionParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) => [{ kind: "rsi", period: p.period }],
  warmupBars: (p) => p.period + 1,
  init: (params) => ({ params, prevRsi: null }),
  analyze(context, state): StrategyVerdict {
    const p = state.params;
    const rsi = context.indicators[`rsi${p.period}`];
    if (rsi === undefined) return hold("RSI not ready");

    const prev = state.prevRsi;
    state.prevRsi = rsi;
    if (prev === null) return hold("seeding re-cross state");

    const close = context.candle.close;

    // Buy: cross back UP through oversold (plan/16 §3).
    if (prev < p.oversold && rsi >= p.oversold) {
      let stopLoss =
        recentLow(context.candles, p.swingLookback) ?? close * 0.99;
      if (stopLoss >= close) stopLoss = close * 0.99;
      const risk = close - stopLoss;
      // Deeper extreme → stronger conviction (RSI 18 recovering > RSI 29).
      const depth = clamp01((p.oversold - prev) / p.oversold);
      return {
        side: "BUY",
        confidence: clamp01(0.4 + depth),
        qtyProposal: p.quantity,
        stopLoss,
        target: close + p.targetR * risk,
        reason: `RSI re-crossed up through ${p.oversold}`,
      };
    }

    // Cross back DOWN through overbought: exit a long, or short if enabled.
    if (prev > p.overbought && rsi <= p.overbought) {
      if (context.position !== null && context.position.side === "LONG") {
        return {
          side: "SELL",
          confidence: 0.6,
          qtyProposal: context.position.qty,
          reason: `RSI crossed down through ${p.overbought} — exit long`,
        };
      }
      if (p.allowShort && context.position === null) {
        let stopLoss =
          recentHigh(context.candles, p.swingLookback) ?? close * 1.01;
        if (stopLoss <= close) stopLoss = close * 1.01;
        const risk = stopLoss - close;
        const depth = clamp01((prev - p.overbought) / (100 - p.overbought));
        return {
          side: "SELL",
          confidence: clamp01(0.4 + depth),
          qtyProposal: p.quantity,
          stopLoss,
          target: close - p.targetR * risk,
          reason: `RSI re-crossed down through ${p.overbought}`,
        };
      }
    }

    return hold("no re-cross");
  },
};
