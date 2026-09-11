import { z } from "zod";
import {
  CandleIntervalSchema,
  type DerivativeTarget,
  type StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold } from "./shared.js";

/**
 * Index Option Momentum — read the index, buy the option (plan/16).
 *
 * Buying an index option intraday is a race against theta: the position bleeds
 * every minute it is held, so a slow trend-follower that is *eventually* right
 * still loses. Every rule here follows from that one fact.
 *
 *  - **Movement, not just direction.** Entry needs a fresh `breakoutBars`-bar
 *    high (low for puts) — price actually going somewhere — on top of trend
 *    agreement. Direction alone is a losing trade for a buyer if the market
 *    drifts.
 *  - **Two independent trend filters.** Close must be on the right side of
 *    BOTH session VWAP and the EMA. VWAP is where the day's volume actually
 *    traded; the EMA is the shape of the move. Requiring both is what keeps
 *    the strategy out of chop, which is where option buyers die.
 *  - **One entry per direction per day.** Re-entering a chopping market pays
 *    the spread and the decay again for the same idea.
 *  - **A window, not a session.** No entries in the opening `skipOpenMinutes`
 *    (the range is not set and spreads are wide) and none after
 *    `lastEntryMinutes` (decay accelerates into the close, and the square-off
 *    is coming regardless).
 *  - **Percentage stops.** The verdict names stop and target as fractions of
 *    the premium, because the premium is not known until the runner resolves
 *    the contract — and an index level is not a stop for an option anyway.
 *
 * It analyses the INDEX series and declares a `derivative` target; the runner
 * resolves the actual contract (plan/15 §4). A BUY verdict buys a call, a SELL
 * verdict buys a put — this strategy is always a buyer, never a writer, so
 * `SELL` here means "buy a put", not "go short".
 */
export const IndexOptionMomentumParamsSchema = z.object({
  /** Underlying as the symbol master names it, e.g. "NIFTY". */
  underlying: z.string().min(1).default("NIFTY"),
  interval: CandleIntervalSchema.default("5m"),
  /** Trend EMA on the index. */
  emaPeriod: z.number().int().positive().default(21),
  /**
   * Whether to require session VWAP as the second trend filter.
   *
   * Must be FALSE when analysing a spot index. VWAP is only ready once real
   * volume has printed (plan/16 §4), and a spot index feed reports none — so
   * requiring it there means the readiness gate never opens and the strategy
   * silently never runs, which looks identical to "no setup today".
   *
   * Leave it true when analysing something that actually trades — a future,
   * or a stock — where VWAP is the best single read on where the day's volume
   * changed hands.
   */
  useVwap: z.boolean().default(true),
  /** Bars that define the breakout high/low. */
  breakoutBars: z.number().int().positive().default(12),
  /** 0 = at the money; positive moves out of the money. */
  strikeOffset: z.number().int().default(0),
  /** Stop as a fraction of premium paid. */
  stopLossPct: z.number().gt(0).lt(1).default(0.3),
  /** Target as a fraction of premium paid. */
  targetPct: z.number().gt(0).default(0.6),
  /** No entries before this many minutes after the open. */
  skipOpenMinutes: z.number().int().nonnegative().default(20),
  /** No entries after this many minutes into the session. */
  lastEntryMinutes: z.number().int().positive().default(300),
  /** Optional ceiling on size, in units; unset lets risk size it. */
  quantity: z.number().int().positive().optional(),
  allowPut: z.boolean().default(true),
});

export type IndexOptionMomentumParams = z.infer<
  typeof IndexOptionMomentumParamsSchema
>;

export interface IndexOptionMomentumState {
  params: IndexOptionMomentumParams;
  /** The `sessionOpenTs` this state belongs to; a change means a new session. */
  sessionMarker: number | null;
  boughtCall: boolean;
  boughtPut: boolean;
}

export const indexOptionMomentum: StrategyDefinition<
  IndexOptionMomentumParams,
  IndexOptionMomentumState
> = {
  type: "INDEX_OPTION_MOMENTUM",
  paramsSchema: IndexOptionMomentumParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) =>
    p.useVwap
      ? [{ kind: "ema", period: p.emaPeriod }, { kind: "vwap" }]
      : [{ kind: "ema", period: p.emaPeriod }],
  // The EMA seeds from `emaPeriod` closes; the breakout needs its own window.
  warmupBars: (p) => Math.max(p.emaPeriod, p.breakoutBars),
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
    if (ema === undefined) return hold("trend indicators not ready");
    const vwap = p.useVwap ? context.indicators["vwap"] : undefined;
    if (p.useVwap && vwap === undefined) {
      return hold("trend indicators not ready");
    }

    // The breakout window EXCLUDES the deciding bar: a bar is only a breakout
    // if it exceeds what came before it, not if it ties with itself.
    const prior = context.candles.slice(-(p.breakoutBars + 1), -1);
    if (prior.length < p.breakoutBars) return hold("breakout window not ready");
    let priorHigh = -Infinity;
    let priorLow = Infinity;
    for (const bar of prior) {
      priorHigh = Math.max(priorHigh, bar.high);
      priorLow = Math.min(priorLow, bar.low);
    }

    const close = context.candle.close;
    // With VWAP off, the EMA carries the trend filter alone. The breakout
    // requirement below is what still keeps this out of chop.
    const bullish = close > ema && (vwap === undefined || close > vwap);
    const bearish = close < ema && (vwap === undefined || close < vwap);

    // Conviction scales with how far the move extends past the level it broke,
    // measured against the window's own range so it is comparable across days.
    const range = priorHigh - priorLow;
    const extension = (edge: number): number =>
      range > 0 ? Math.abs(close - edge) / range : 0;

    if (bullish && !state.boughtCall && close > priorHigh) {
      state.boughtCall = true;
      return {
        side: "BUY", // → buy a CALL
        confidence: clamp01(0.5 + extension(priorHigh)),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: `index broke ${String(p.breakoutBars)}-bar high above VWAP and EMA${String(p.emaPeriod)}`,
      };
    }

    if (p.allowPut && bearish && !state.boughtPut && close < priorLow) {
      state.boughtPut = true;
      return {
        side: "SELL", // → buy a PUT (never a short)
        confidence: clamp01(0.5 + extension(priorLow)),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: `index broke ${String(p.breakoutBars)}-bar low below VWAP and EMA${String(p.emaPeriod)}`,
      };
    }

    return hold("no breakout with trend agreement");
  },
};
