import { z } from "zod";
import {
  CandleIntervalSchema,
  type DerivativeTarget,
  type OptionChainSnapshot,
  type StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold } from "./shared.js";

export const IndexOptionPcrOiParamsSchema = z.object({
  underlying: z.string().min(1).default("NIFTY"),
  interval: CandleIntervalSchema.default("5m"),
  emaPeriod: z.number().int().positive().default(21),
  strikeOffset: z.number().int().default(0),
  bullishPcrMin: z.number().positive().default(1.05),
  bearishPcrMax: z.number().positive().default(0.75),
  minOiChangePct: z.number().nonnegative().max(1).default(0.05),
  maxChainAgeMinutes: z.number().positive().default(5),
  stopLossPct: z.number().gt(0).lt(1).default(0.25),
  targetPct: z.number().gt(0).default(0.65),
  skipOpenMinutes: z.number().int().nonnegative().default(20),
  lastEntryMinutes: z.number().int().positive().default(300),
  quantity: z.number().int().positive().optional(),
  allowPut: z.boolean().default(true),
});

export type IndexOptionPcrOiParams = z.infer<
  typeof IndexOptionPcrOiParamsSchema
>;

export interface IndexOptionPcrOiState {
  params: IndexOptionPcrOiParams;
  sessionMarker: number | null;
  boughtCall: boolean;
  boughtPut: boolean;
}

interface ChainMetrics {
  pcr: number;
  putChangePct: number;
  callChangePct: number;
}

function metrics(chain: OptionChainSnapshot): ChainMetrics | null {
  const totals = chain.rows.reduce(
    (sum, row) => ({
      callOi: sum.callOi + row.callOI,
      putOi: sum.putOi + row.putOI,
      callChange: sum.callChange + row.callChangeOI,
      putChange: sum.putChange + row.putChangeOI,
    }),
    { callOi: 0, putOi: 0, callChange: 0, putChange: 0 },
  );
  if (totals.callOi <= 0 || totals.putOi <= 0) return null;
  return {
    pcr: totals.putOi / totals.callOi,
    putChangePct: totals.putChange / totals.putOi,
    callChangePct: totals.callChange / totals.callOi,
  };
}

export const indexOptionPcrOi: StrategyDefinition<
  IndexOptionPcrOiParams,
  IndexOptionPcrOiState
> = {
  type: "INDEX_OPTION_PCR_OI",
  paramsSchema: IndexOptionPcrOiParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) => [{ kind: "ema", period: p.emaPeriod }],
  requiresOptionChain: () => true,
  warmupBars: (p) => p.emaPeriod,
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
    const { sessionOpenTs, minutesSinceOpen } = context.session;
    if (state.sessionMarker !== sessionOpenTs) {
      state.boughtCall = false;
      state.boughtPut = false;
      state.sessionMarker = sessionOpenTs;
    }
    if (minutesSinceOpen < p.skipOpenMinutes) return hold("inside the opening window");
    if (minutesSinceOpen > p.lastEntryMinutes) return hold("past the last entry time");

    const chain = context.optionChain;
    if (chain === undefined) return hold("option chain not available");
    if (chain.underlying !== p.underlying) return hold("option chain underlying mismatch");
    if (
      chain.asOf > context.candle.ts ||
      context.candle.ts - chain.asOf > p.maxChainAgeMinutes * 60_000
    ) {
      return hold("option chain is stale");
    }

    const ema = context.indicators[`ema${p.emaPeriod}`];
    const chainMetrics = metrics(chain);
    if (ema === undefined || chainMetrics === null) {
      return hold("PCR/OI inputs not ready");
    }

    const bullishOi = chainMetrics.putChangePct >= p.minOiChangePct;
    const bearishOi = chainMetrics.callChangePct >= p.minOiChangePct;
    const bullish =
      context.candle.close > ema &&
      chainMetrics.pcr >= p.bullishPcrMin &&
      bullishOi &&
      !state.boughtCall;
    const bearish =
      context.candle.close < ema &&
      chainMetrics.pcr <= p.bearishPcrMax &&
      bearishOi &&
      !state.boughtPut;

    if (bullish) {
      state.boughtCall = true;
      return {
        side: "BUY",
        confidence: clamp01(0.45 + Math.min(chainMetrics.pcr - p.bullishPcrMin, 0.5)),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: `PCR/OI bullish: PCR ${chainMetrics.pcr.toFixed(2)} with put OI buildup`,
      };
    }

    if (p.allowPut && bearish) {
      state.boughtPut = true;
      return {
        side: "SELL",
        confidence: clamp01(0.45 + Math.min(p.bearishPcrMax - chainMetrics.pcr, 0.5)),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: `PCR/OI bearish: PCR ${chainMetrics.pcr.toFixed(2)} with call OI buildup`,
      };
    }

    return hold("PCR/OI and price trend are not aligned");
  },
};