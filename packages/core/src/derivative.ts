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
});
export type DerivativeTarget = z.infer<typeof DerivativeTargetSchema>;

/** A BUY verdict buys a call; a SELL verdict buys a put (plan/16). */
export function optionTypeForSide(side: "BUY" | "SELL"): OptionType {
  return side === "BUY" ? "CE" : "PE";
}
