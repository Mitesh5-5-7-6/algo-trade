import { z } from "zod";
import type { DetectionResult, PatternDetector } from "./contract.js";

export const EmaCrossParamsSchema = z
  .object({
    fast: z.number().int().positive().default(9),
    slow: z.number().int().positive().default(21),
  })
  .refine((p) => p.fast < p.slow, {
    message: "fast period must be shorter than slow",
  });
export type EmaCrossParams = z.infer<typeof EmaCrossParamsSchema>;

/**
 * Moving-average cross: the fast EMA crosses the slow one.
 *
 * The cross is detected from the two EMAs on THIS bar plus their relationship
 * on the previous bar, which the detector reconstructs from the candle window
 * rather than from remembered state. A detector that carried state between
 * calls would give different answers depending on where a replay started — and
 * replay determinism is the property Phase 4 exists to establish.
 */
export const emaCross: PatternDetector<EmaCrossParams> = {
  patternId: "EMA_CROSS",
  detectorVersion: "1.0.0",
  definition:
    "The fast EMA crosses from below to above the slow EMA (bullish), or " +
    "from above to below (bearish), measured at bar close.",
  paramsSchema: EmaCrossParamsSchema,
  requiredIndicators: (p) => [
    { kind: "ema", period: p.fast },
    { kind: "ema", period: p.slow },
  ],
  warmupBars: (p) => p.slow + 1,

  detect(context, p): DetectionResult | null {
    const fast = context.indicators[`ema${String(p.fast)}`];
    const slow = context.indicators[`ema${String(p.slow)}`];
    const prevFast = context.previousIndicators[`ema${String(p.fast)}`];
    const prevSlow = context.previousIndicators[`ema${String(p.slow)}`];
    if (
      fast === undefined ||
      slow === undefined ||
      prevFast === undefined ||
      prevSlow === undefined
    ) {
      return null;
    }

    const evidence = { fast, slow, prevFast, prevSlow };
    // A cross needs the relationship to have INVERTED. "fast is above slow" is
    // a state, not an event, and treating it as one would mark every bar of a
    // trend as a fresh pattern.
    if (prevFast <= prevSlow && fast > slow) {
      return { direction: "BULLISH", evidence };
    }
    if (prevFast >= prevSlow && fast < slow) {
      return { direction: "BEARISH", evidence };
    }
    return null;
  },
};
