import { z } from "zod";
import type { OptionType } from "./instrument.js";

/**
 * What a strategy wants to trade, when that is not the thing it analyses.
 *
 * An index-options strategy reads NIFTY and buys a NIFTY call — two different
 * symbols, and the second one cannot be configured in advance because the
 * right strike depends on where spot is at signal time, and the right expiry
 * changes every week.
 *
 * `analyze()` is pure and synchronous by contract (plan/15 §2), so it cannot
 * perform the lookup itself. It declares the *shape* of the contract it wants
 * and the Strategy Runner resolves it against the symbol master — keeping the
 * decision function deterministic and testable while the resolution, which
 * depends on live spot and the clock, happens where I/O is allowed.
 */
export const DerivativeTargetSchema = z.object({
  /** Underlying as the symbol master names it, e.g. "NIFTY". */
  underlying: z.string().min(1),
  kind: z.enum(["OPTION", "FUTURE"]),
  /**
   * Strikes away from the money, signed toward out-of-the-money. 0 is ATM.
   *
   * ATM is the default because it carries the most delta per rupee of premium
   * an intraday buyer can actually recover; far-OTM strikes are cheap for the
   * reason that they usually expire worthless.
   */
  strikeOffset: z.number().int().default(0),
  /**
   * Skip expiries closer than this many days (PLAN.md 14.24). A near
   * expiry's decay is several times a later one's; on 14 months of history
   * that decay, with charges, erased the option strategies' small edge.
   * Absent or 0 = the nearest expiry.
   */
  minDaysToExpiry: z.number().int().nonnegative().optional(),
});
export type DerivativeTarget = z.infer<typeof DerivativeTargetSchema>;

/** A BUY verdict buys a call; a SELL verdict buys a put (plan/16). */
export function optionTypeForSide(side: "BUY" | "SELL"): OptionType {
  return side === "BUY" ? "CE" : "PE";
}

/**
 * The market direction an order takes, as BUY (bullish) or SELL (bearish).
 *
 * For anything but an option the order side IS the direction. An option is
 * different: every option entry is a BUY (14.8), and buying a put is a
 * bearish trade. Reading the order side alone made the market-bias check
 * block every bought put on a bearish day — the day a put is right
 * (paper review 2026-11-23: four put entries refused on a −2% session).
 *
 * The option type is read off the traded symbol's suffix, as FYERS names
 * every option contract (…CE / …PE). `underlyingSymbol` is required as well,
 * so an equity whose ticker happens to end in "PE" is never mistaken for a
 * put: only a derivative signal carries one.
 */
export function directionalSide(signal: {
  side: "BUY" | "SELL";
  symbol: string;
  underlyingSymbol?: string | undefined;
}): "BUY" | "SELL" {
  if (signal.underlyingSymbol === undefined) return signal.side;
  if (!signal.symbol.endsWith("PE")) return signal.side;
  return signal.side === "BUY" ? "SELL" : "BUY";
}
