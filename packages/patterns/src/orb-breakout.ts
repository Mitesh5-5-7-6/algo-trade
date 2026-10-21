import { z } from "zod";
import type { DetectionResult, PatternDetector } from "./contract.js";
import { highestHigh, lowestLow, openingRange } from "./shared.js";

export const OrbBreakoutParamsSchema = z.object({
  /** Minutes from the open that define the range. */
  rangeMinutes: z.number().int().positive().default(15),
  /** Ignore breaks before the range is complete. */
  minMinutesSinceOpen: z.number().int().nonnegative().default(15),
});
export type OrbBreakoutParams = z.infer<typeof OrbBreakoutParamsSchema>;

/**
 * Opening-range breakout: the session's first `rangeMinutes` define a range,
 * and a later bar CLOSES outside it.
 *
 * Closes rather than touches. An intrabar spike that is rejected before the
 * bell is not a breakout, and counting it would populate the matrix with
 * structures no strategy could have acted on at bar close.
 */
export const orbBreakout: PatternDetector<OrbBreakoutParams> = {
  patternId: "ORB_BREAKOUT",
  detectorVersion: "1.0.0",
  definition:
    "The first N minutes of the session form a range; a later bar closes " +
    "above its high (bullish) or below its low (bearish).",
  paramsSchema: OrbBreakoutParamsSchema,
  requiredIndicators: () => [],
  /**
   * None. The range is defined in MINUTES and this detector does not know the
   * bar size, so any bar count here would be a guess — and returning
   * `rangeMinutes` would suppress genuine 09:30 breakouts for the first 15
   * bars of every session, which on 5-minute candles is most of the morning.
   *
   * It needs no warm-up regardless: it gates itself on the session clock and
   * on the decision bar lying outside the range window, and the sweep gives it
   * a candle window that starts at the session open.
   */
  warmupBars: () => 0,

  detect(context, p): DetectionResult | null {
    if (context.minutesSinceOpen < p.minMinutesSinceOpen) return null;

    const range = openingRange(
      context.candles,
      context.sessionOpenTs,
      p.rangeMinutes,
    );
    if (range.length === 0) return null;

    // The decision bar must be outside the range window, or it would be
    // breaking out of a range it is itself part of.
    if (context.candle.ts < context.sessionOpenTs + p.rangeMinutes * 60_000) {
      return null;
    }

    const rangeHigh = highestHigh(range);
    const rangeLow = lowestLow(range);
    const close = context.candle.close;
    const evidence = { rangeHigh, rangeLow, close, rangeBars: range.length };

    if (close > rangeHigh) return { direction: "BULLISH", evidence };
    if (close < rangeLow) return { direction: "BEARISH", evidence };
    return null;
  },
};
