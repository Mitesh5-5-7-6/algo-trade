import { z } from "zod";
import {
  CandleIntervalSchema,
  type DerivativeTarget,
  type StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold } from "./shared.js";

/**
 * Index Option Flow Breakout — trend-following index option setup built around
 * flow confirmation rather than raw breakout alone.
 *
 * The idea follows the OI/PCR-style tutorial logic: the best index option trades
 * come when price breaks with breadth, momentum and sentiment aligned, not when
 * the index simply drifts up or down. This variant reads the index itself, but
 * only enters when the breakout is backed by strong volume, trend agreement, and
 * positive conviction from the built-in sentiment signal.
 */
export const IndexOptionFlowBreakoutParamsSchema = z.object({
  underlying: z.string().min(1).default("NIFTY"),
  interval: CandleIntervalSchema.default("5m"),
  emaPeriod: z.number().int().positive().default(21),
  rsiPeriod: z.number().int().positive().default(14),
  breakoutBars: z.number().int().positive().default(12),
  strikeOffset: z.number().int().default(0),
  volumeMultiple: z.number().gt(0).default(1.2),
  sentimentThreshold: z.number().min(-1).max(1).default(0.2),
  stopLossPct: z.number().gt(0).lt(1).default(0.25),
  targetPct: z.number().gt(0).default(0.6),
  skipOpenMinutes: z.number().int().nonnegative().default(20),
  lastEntryMinutes: z.number().int().positive().default(300),
  quantity: z.number().int().positive().optional(),
  allowPut: z.boolean().default(true),
});

export type IndexOptionFlowBreakoutParams = z.infer<
  typeof IndexOptionFlowBreakoutParamsSchema
>;

export interface IndexOptionFlowBreakoutState {
  params: IndexOptionFlowBreakoutParams;
  sessionMarker: number | null;
  boughtCall: boolean;
  boughtPut: boolean;
}

export const indexOptionFlowBreakout: StrategyDefinition<
  IndexOptionFlowBreakoutParams,
  IndexOptionFlowBreakoutState
> = {
  type: "INDEX_OPTION_FLOW_BREAKOUT",
  paramsSchema: IndexOptionFlowBreakoutParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) => [
    { kind: "ema", period: p.emaPeriod },
    { kind: "rsi", period: p.rsiPeriod },
  ],
  warmupBars: (p) => Math.max(p.emaPeriod, p.rsiPeriod),
  derivative: (p): DerivativeTarget => ({
    underlying: p.underlying,
    kind: "OPTION",
    strikeOffset: p.strikeOffset,
  }),
  init: (params) => ({
    params,
    sessionMarker: null,
    boughtCall: false,
    boughtPut: false,
  }),
  analyze(context, state): StrategyVerdict {
    const p = state.params;
    const { sessionOpenTs, minutesSinceOpen: mso } = context.session;

    if (state.sessionMarker !== sessionOpenTs) {
      state.boughtCall = false;
      state.boughtPut = false;
    }
    state.sessionMarker = sessionOpenTs;

    if (mso < p.skipOpenMinutes) return hold("inside the opening window");
    if (mso > p.lastEntryMinutes) return hold("past the last entry time");

    const ema = context.indicators[`ema${p.emaPeriod}`];
    const rsi = context.indicators[`rsi${p.rsiPeriod}`];
    if (ema === undefined || rsi === undefined) {
      return hold("trend indicators not ready");
    }

    const prior = context.candles.slice(-(p.breakoutBars + 1), -1);
    if (prior.length < p.breakoutBars) return hold("breakout window not ready");

    let priorHigh = Number.NEGATIVE_INFINITY;
    let priorLow = Number.POSITIVE_INFINITY;
    let avgVolume = 0;
    for (const bar of prior) {
      priorHigh = Math.max(priorHigh, bar.high);
      priorLow = Math.min(priorLow, bar.low);
      avgVolume += bar.volume;
    }
    avgVolume /= prior.length;

    const currentVolume = context.candle.volume;
    const volumeConfirmed = currentVolume >= avgVolume * p.volumeMultiple;
    const bullish = context.candle.close > ema && rsi > 50;
    const bearish = context.candle.close < ema && rsi < 50;
    const sentimentBullish = context.sentiment >= p.sentimentThreshold;
    const sentimentBearish = context.sentiment <= -p.sentimentThreshold;

    if (
      bullish &&
      sentimentBullish &&
      volumeConfirmed &&
      !state.boughtCall &&
      context.candle.close > priorHigh
    ) {
      state.boughtCall = true;
      return {
        side: "BUY",
        confidence: clamp01(0.5 + (context.candle.close - priorHigh) / Math.max(priorHigh - priorLow, 1)),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: "flow breakout: breakout with momentum, volume and positive sentiment",
      };
    }

    if (
      p.allowPut &&
      bearish &&
      sentimentBearish &&
      volumeConfirmed &&
      !state.boughtPut &&
      context.candle.close < priorLow
    ) {
      state.boughtPut = true;
      return {
        side: "SELL",
        confidence: clamp01(0.5 + (priorLow - context.candle.close) / Math.max(priorHigh - priorLow, 1)),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: "flow breakout: breakdown with momentum, volume and negative sentiment",
      };
    }

    return hold("no flow breakout");
  },
};
