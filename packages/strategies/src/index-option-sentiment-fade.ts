import { z } from "zod";
import {
  CandleIntervalSchema,
  type DerivativeTarget,
  type StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold } from "./shared.js";

/**
 * Index Option Sentiment Fade — fade adverse sentiment after an oversold/extreme
 * move. It looks for a reversal where price is rolling over, RSI is recovering
 * off extreme levels, and sentiment has already become strongly negative.
 *
 * This matches the PCR-style reversal idea: when option sentiment reaches an
 * extreme, the next move can be a contrarian bounce. The setup is better as a
 * directional buyer of calls during bearish panic, not a pure mean-reversion short.
 */
export const IndexOptionSentimentFadeParamsSchema = z.object({
  underlying: z.string().min(1).default("NIFTY"),
  interval: CandleIntervalSchema.default("5m"),
  emaPeriod: z.number().int().positive().default(21),
  rsiPeriod: z.number().int().positive().default(14),
  oversold: z.number().default(30),
  overbought: z.number().default(70),
  swingLookback: z.number().int().positive().default(10),
  strikeOffset: z.number().int().default(0),
  sentimentThreshold: z.number().min(-1).max(1).default(0.35),
  stopLossPct: z.number().gt(0).lt(1).default(0.3),
  targetPct: z.number().gt(0).default(0.6),
  skipOpenMinutes: z.number().int().nonnegative().default(20),
  lastEntryMinutes: z.number().int().positive().default(300),
  quantity: z.number().int().positive().optional(),
  allowPut: z.boolean().default(true),
});

export type IndexOptionSentimentFadeParams = z.infer<
  typeof IndexOptionSentimentFadeParamsSchema
>;

export interface IndexOptionSentimentFadeState {
  params: IndexOptionSentimentFadeParams;
  sessionMarker: number | null;
  boughtCall: boolean;
  boughtPut: boolean;
  prevRsi: number | null;
}

export const indexOptionSentimentFade: StrategyDefinition<
  IndexOptionSentimentFadeParams,
  IndexOptionSentimentFadeState
> = {
  type: "INDEX_OPTION_SENTIMENT_FADE",
  paramsSchema: IndexOptionSentimentFadeParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) => [
    { kind: "ema", period: p.emaPeriod },
    { kind: "rsi", period: p.rsiPeriod },
  ],
  warmupBars: (p) => Math.max(p.emaPeriod, p.rsiPeriod + 1),
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
    prevRsi: null,
  }),
  analyze(context, state): StrategyVerdict {
    const p = state.params;
    const { sessionOpenTs, minutesSinceOpen: mso } = context.session;

    if (state.sessionMarker !== sessionOpenTs) {
      state.boughtCall = false;
      state.boughtPut = false;
      state.prevRsi = null;
    }
    state.sessionMarker = sessionOpenTs;

    if (mso < p.skipOpenMinutes) return hold("inside the opening window");
    if (mso > p.lastEntryMinutes) return hold("past the last entry time");

    const ema = context.indicators[`ema${p.emaPeriod}`];
    const rsi = context.indicators[`rsi${p.rsiPeriod}`];
    if (ema === undefined || rsi === undefined) {
      return hold("trend indicators not ready");
    }

    const prevRsi = state.prevRsi;
    state.prevRsi = rsi;

    const bearishPanic =
      context.candle.close < ema &&
      rsi >= p.oversold &&
      context.sentiment <= -p.sentimentThreshold;
    const bullishRecovery =
      prevRsi !== null && prevRsi <= p.oversold && rsi > prevRsi;

    if (
      bearishPanic &&
      bullishRecovery &&
      !state.boughtCall
    ) {
      state.boughtCall = true;
      return {
        side: "BUY",
        confidence: clamp01(0.45 + (p.oversold - rsi) / 100),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: "fade: bearish extreme with recovery and negative sentiment",
      };
    }

    if (
      p.allowPut &&
      context.candle.close > ema &&
      rsi >= p.overbought &&
      context.sentiment >= p.sentimentThreshold &&
      prevRsi !== null &&
      prevRsi > p.overbought &&
      rsi < prevRsi &&
      !state.boughtPut
    ) {
      state.boughtPut = true;
      return {
        side: "SELL",
        confidence: clamp01(0.45 + (rsi - p.overbought) / 100),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: "fade: bullish extreme with exhaustion and positive sentiment",
      };
    }

    return hold("no sentiment fade");
  },
};
