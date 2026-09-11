import { z } from "zod";
import { SymbolSchema, TimestampSchema } from "./primitives.js";

/**
 * Which way the market as a whole is leaning.
 *
 * NEUTRAL is a real answer, not a failure to decide: it is what the market
 * looks like when direction and participation disagree, and acting as though
 * one of them were authoritative is the mistake this type exists to prevent.
 */
export const MarketBiasSchema = z.enum(["BULLISH", "BEARISH", "NEUTRAL"]);
export type MarketBias = z.infer<typeof MarketBiasSchema>;

/** One index's read: where it sits against its own trend and session VWAP. */
export const IndexReadSchema = z.object({
  symbol: SymbolSchema,
  bias: MarketBiasSchema,
  close: z.number(),
  ema: z.number().optional(),
  vwap: z.number().optional(),
});
export type IndexRead = z.infer<typeof IndexReadSchema>;

/**
 * The market view every entry is checked against (plan/14 §4).
 *
 * Two independent questions, deliberately kept apart until the last step:
 *
 *  - **Direction** (`indexBias`) — are the indices above their own trend?
 *  - **Participation** (`breadthBias`) — are most instruments actually up?
 *
 * They are combined by agreement, because each answers a failure the other
 * cannot see. An index can climb on two heavyweights while the majority of
 * stocks fall, which reads bullish and trades badly; and a broad advance
 * beneath a falling index is a bounce inside a downtrend. Requiring both to
 * agree is what makes the resulting bias worth blocking on.
 */
export const MarketViewSchema = z.object({
  /** The combined verdict — what the risk gate actually uses. */
  bias: MarketBiasSchema,
  indexBias: MarketBiasSchema,
  breadthBias: MarketBiasSchema,
  /** Per-index detail, for the dashboard and the audit trail. */
  indices: z.array(IndexReadSchema),
  advancing: z.number().int().nonnegative(),
  declining: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  /** One line explaining the verdict, recorded on every risk decision. */
  detail: z.string(),
  ts: TimestampSchema,
});
export type MarketView = z.infer<typeof MarketViewSchema>;

/**
 * The view when there is not enough data to have one — the boot state, and
 * what a missing index feed degrades to.
 *
 * NEUTRAL rather than a guess, and NEUTRAL rather than fail-closed: the gate
 * exists to stop trades the market contradicts, not to stop trading whenever
 * the market is unreadable. That asymmetry is deliberate — compare the Risk
 * Engine's own fail-*closed* stance on limits, where the unverifiable thing is
 * the operator's safety envelope rather than an opinion about direction.
 */
export const UNKNOWN_MARKET_VIEW: MarketView = {
  bias: "NEUTRAL",
  indexBias: "NEUTRAL",
  breadthBias: "NEUTRAL",
  indices: [],
  advancing: 0,
  declining: 0,
  unchanged: 0,
  detail: "no market data yet",
  ts: 0,
};

/**
 * Does `side` trade *against* the market view?
 *
 * Only an outright contradiction counts: long into a bearish market, short
 * into a bullish one. NEUTRAL contradicts nothing — when direction and
 * participation disagree the market is not making a case either way, and
 * blocking both sides there would halt trading on ambiguity rather than on
 * evidence.
 */
export function contradictsMarket(
  side: "BUY" | "SELL",
  view: MarketView,
): boolean {
  if (view.bias === "BULLISH") return side === "SELL";
  if (view.bias === "BEARISH") return side === "BUY";
  return false;
}
