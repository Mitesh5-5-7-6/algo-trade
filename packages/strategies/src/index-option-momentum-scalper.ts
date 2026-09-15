import { z } from "zod";
import {
  CandleIntervalSchema,
  type DerivativeTarget,
  type OptionChainRow,
  type StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold } from "./shared.js";

/**
 * Research hypothesis, not a profitability claim. The strategy only emits a
 * signal after the underlying breakout and the selected option's quote data
 * agree on the completed decision candle.
 */
export const IndexOptionMomentumScalperParamsSchema = z.object({
  underlying: z.string().min(1).default("NIFTY"),
  interval: CandleIntervalSchema.default("1m"),
  emaFast: z.number().int().positive().default(9),
  emaSlow: z.number().int().positive().default(20),
  breakoutBars: z.number().int().positive().default(5),
  averageVolumePeriod: z.number().int().positive().default(20),
  volumeMultiplier: z.number().positive().default(1.2),
  optionVolumeMultiplier: z.number().positive().default(1.05),
  minOI: z.number().nonnegative().default(1000),
  minOIChange: z.number().nonnegative().default(0),
  minOptionVolume: z.number().nonnegative().default(100),
  minOptionPriceChangePct: z.number().nonnegative().default(0.002),
  maxSpreadPercent: z.number().positive().default(1.5),
  maxChainAgeMinutes: z.number().positive().default(2),
  maxResistanceOiRatio: z.number().positive().default(2.5),
  confirmationBars: z.union([z.literal(0), z.literal(1)]).default(0),
  strikeOffset: z.number().int().default(0),
  stopLossPct: z.number().gt(0).lt(1).default(0.2),
  targetPct: z.number().gt(0).default(0.3),
  skipOpenMinutes: z.number().int().nonnegative().default(5),
  lastEntryMinutes: z.number().int().positive().default(360),
  quantity: z.number().int().positive().optional(),
  allowPut: z.boolean().default(true),
});

export type IndexOptionMomentumScalperParams = z.infer<
  typeof IndexOptionMomentumScalperParamsSchema
>;

interface PreviousOptionObservation {
  asOf: number;
  optionType: "CE" | "PE";
  strike: number;
  price: number;
  volume: number;
  oi: number;
}

export interface IndexOptionMomentumScalperState {
  params: IndexOptionMomentumScalperParams;
  sessionMarker: number | null;
  boughtCall: boolean;
  boughtPut: boolean;
  pendingSide: "BUY" | "SELL" | null;
  pendingBars: number;
  previousOption: PreviousOptionObservation | null;
}

type OptionSide = "CE" | "PE";

function optionFields(
  row: OptionChainRow,
  optionType: OptionSide,
): {
  price: number | undefined;
  volume: number | undefined;
  oi: number;
  oiChange: number;
  bid: number | undefined;
  ask: number | undefined;
} {
  return optionType === "CE"
    ? {
        price: row.callLtp,
        volume: row.callVolume,
        oi: row.callOI,
        oiChange: row.callChangeOI,
        bid: row.callBid,
        ask: row.callAsk,
      }
    : {
        price: row.putLtp,
        volume: row.putVolume,
        oi: row.putOI,
        oiChange: row.putChangeOI,
        bid: row.putBid,
        ask: row.putAsk,
      };
}

function nearestRow(
  rows: readonly OptionChainRow[],
  spot: number,
  optionType: OptionSide,
  strikeOffset: number,
): OptionChainRow | null {
  const candidates = [...rows].sort(
    (left, right) => left.strike - right.strike,
  );
  let baseIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, row] of candidates.entries()) {
    const distance = Math.abs(row.strike - spot);
    if (distance < bestDistance) {
      bestDistance = distance;
      baseIndex = index;
    }
  }
  const index =
    baseIndex + (optionType === "CE" ? strikeOffset : -strikeOffset);
  return candidates[index] ?? null;
}

function resistanceBlocked(
  rows: readonly OptionChainRow[],
  selected: OptionChainRow,
  optionType: OptionSide,
  maxRatio: number,
): boolean {
  const nearby = rows
    .filter((row) =>
      optionType === "CE"
        ? row.strike > selected.strike
        : row.strike < selected.strike,
    )
    .sort((left, right) =>
      optionType === "CE"
        ? left.strike - right.strike
        : right.strike - left.strike,
    )[0];
  if (nearby === undefined) return false;
  const selectedOi = optionFields(selected, optionType).oi;
  const nearbyOi = optionFields(nearby, optionType).oi;
  return selectedOi > 0 && nearbyOi > selectedOi * maxRatio;
}

function spreadPercent(bid: number, ask: number): number {
  const midpoint = (bid + ask) / 2;
  return midpoint <= 0
    ? Number.POSITIVE_INFINITY
    : ((ask - bid) / midpoint) * 100;
}

export const indexOptionMomentumScalper: StrategyDefinition<
  IndexOptionMomentumScalperParams,
  IndexOptionMomentumScalperState
> = {
  type: "OPTION_MOMENTUM_SCALPER",
  paramsSchema: IndexOptionMomentumScalperParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) => [
    { kind: "ema", period: p.emaFast },
    { kind: "ema", period: p.emaSlow },
    { kind: "vwap" },
    { kind: "avgVolume", period: p.averageVolumePeriod },
  ],
  requiresOptionChain: () => true,
  warmupBars: (p) =>
    Math.max(p.emaSlow, p.averageVolumePeriod, p.breakoutBars + 1),
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
    pendingSide: null,
    pendingBars: 0,
    previousOption: null,
  }),
  analyze(context, state): StrategyVerdict {
    const p = state.params;
    const { sessionOpenTs, minutesSinceOpen } = context.session;
    if (state.sessionMarker !== sessionOpenTs) {
      state.boughtCall = false;
      state.boughtPut = false;
      state.pendingSide = null;
      state.pendingBars = 0;
      state.previousOption = null;
      state.sessionMarker = sessionOpenTs;
    }
    if (minutesSinceOpen < p.skipOpenMinutes)
      return hold("inside the opening window");
    if (minutesSinceOpen > p.lastEntryMinutes)
      return hold("past the last entry time");

    const chain = context.optionChain;
    if (chain === undefined) return hold("option chain not available");
    if (chain.underlying !== p.underlying)
      return hold("option chain underlying mismatch");
    if (
      chain.asOf > context.candle.ts ||
      context.candle.ts - chain.asOf > p.maxChainAgeMinutes * 60_000
    ) {
      return hold("option chain is stale");
    }

    const emaFast = context.indicators[`ema${p.emaFast}`];
    const emaSlow = context.indicators[`ema${p.emaSlow}`];
    const vwap = context.indicators.vwap;
    const averageVolume = context.indicators[`avgvol${p.averageVolumePeriod}`];
    if (
      [emaFast, emaSlow, vwap, averageVolume].some(
        (value) => value === undefined,
      )
    ) {
      return hold("scalper indicators not ready");
    }

    const prior = context.candles.slice(-(p.breakoutBars + 1), -1);
    if (prior.length < p.breakoutBars) return hold("breakout window not ready");
    const priorHigh = Math.max(...prior.map((bar) => bar.high));
    const priorLow = Math.min(...prior.map((bar) => bar.low));
    const volumeExpanded =
      context.candle.volume >= averageVolume! * p.volumeMultiplier;
    const bullish =
      context.candle.close > vwap! &&
      emaFast! > emaSlow! &&
      context.candle.close > priorHigh &&
      volumeExpanded;
    const bearish =
      context.candle.close < vwap! &&
      emaFast! < emaSlow! &&
      context.candle.close < priorLow &&
      volumeExpanded;
    if (!bullish && !bearish) {
      state.pendingSide = null;
      state.pendingBars = 0;
      return hold("underlying momentum conditions are not aligned");
    }

    const side: "BUY" | "SELL" = bullish ? "BUY" : "SELL";
    const optionType: OptionSide = bullish ? "CE" : "PE";
    if (side === "SELL" && !p.allowPut) return hold("put scalping is disabled");
    if (
      (side === "BUY" && state.boughtCall) ||
      (side === "SELL" && state.boughtPut)
    ) {
      return hold("one scalp per direction per session");
    }

    const selected = nearestRow(
      chain.rows,
      chain.spot,
      optionType,
      p.strikeOffset,
    );
    if (selected === null) return hold("no suitable option strike");
    const option = optionFields(selected, optionType);
    if (
      option.price === undefined ||
      option.volume === undefined ||
      option.bid === undefined ||
      option.ask === undefined
    ) {
      return hold("option quote is incomplete");
    }
    if (option.oi < p.minOI || option.volume < p.minOptionVolume) {
      return hold("option liquidity is below minimums");
    }
    if (spreadPercent(option.bid, option.ask) > p.maxSpreadPercent) {
      return hold("option spread is too wide");
    }
    if (
      resistanceBlocked(
        chain.rows,
        selected,
        optionType,
        p.maxResistanceOiRatio,
      )
    ) {
      return hold("nearby option-chain resistance is too strong");
    }

    const previous = state.previousOption;
    state.previousOption = {
      asOf: chain.asOf,
      optionType,
      strike: selected.strike,
      price: option.price,
      volume: option.volume,
      oi: option.oi,
    };
    if (
      previous === null ||
      previous.asOf >= chain.asOf ||
      previous.optionType !== optionType ||
      previous.strike !== selected.strike
    ) {
      return hold("option momentum observation warming");
    }

    const priceMomentum =
      option.price >= previous.price * (1 + p.minOptionPriceChangePct);
    const volumeMomentum =
      option.volume >= previous.volume * p.optionVolumeMultiplier;
    const oiActive = Math.abs(option.oi - previous.oi) >= p.minOIChange;
    if (!priceMomentum || !volumeMomentum || !oiActive) {
      state.pendingSide = null;
      state.pendingBars = 0;
      return hold("option momentum, volume and OI activity are not aligned");
    }

    if (p.confirmationBars === 1 && state.pendingSide !== side) {
      state.pendingSide = side;
      state.pendingBars = 1;
      return hold("breakout confirmed once; waiting for second candle");
    }

    state.pendingSide = null;
    state.pendingBars = 0;
    if (side === "BUY") state.boughtCall = true;
    else state.boughtPut = true;
    const spread = spreadPercent(option.bid, option.ask);
    const breakoutLevel = bullish ? priorHigh : priorLow;
    return {
      side,
      confidence: clamp01(
        0.55 +
          Math.min(
            Math.abs(option.oi - previous.oi) / Math.max(option.oi, 1),
            0.25,
          ),
      ),
      ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
      stopLossPct: p.stopLossPct,
      targetPct: p.targetPct,
      reason:
        `option-momentum-scalper.v1 ${optionType} ${selected.strike}: ` +
        `${bullish ? "breakout" : "breakdown"} ${breakoutLevel.toFixed(2)}, ` +
        `premium ${option.price.toFixed(2)}, volume ${String(option.volume)}, ` +
        `OI change ${String(option.oi - previous.oi)}, spread ${spread.toFixed(2)}%`,
    };
  },
};
