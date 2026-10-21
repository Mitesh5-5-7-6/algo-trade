import { z } from "zod";
import type { DetectionResult, PatternDetector } from "./contract.js";

export const RsiReversionParamsSchema = z.object({
  period: z.number().int().positive().default(14),
  oversold: z.number().min(0).max(100).default(30),
  overbought: z.number().min(0).max(100).default(70),
});
export type RsiReversionParams = z.infer<typeof RsiReversionParamsSchema>;

/**
 * Reversion from an extreme: RSI leaves oversold upward, or overbought
 * downward.
 *
 * The RE-CROSS is the pattern, not the extreme itself. RSI at 22 and still
 * falling is a knife; RSI crossing back up through 30 is the structure that
 * says the fall has paused. Marking the extreme instead would fire on every
 * bar of a decline.
 */
export const rsiReversion: PatternDetector<RsiReversionParams> = {
  patternId: "RSI_REVERSION",
  detectorVersion: "1.0.0",
  definition:
    "RSI crosses back up through the oversold line (bullish) or back down " +
    "through the overbought line (bearish), at bar close.",
  paramsSchema: RsiReversionParamsSchema,
  requiredIndicators: (p) => [{ kind: "rsi", period: p.period }],
  warmupBars: (p) => p.period + 1,

  detect(context, p): DetectionResult | null {
    const rsi = context.indicators[`rsi${String(p.period)}`];
    const prev = context.previousIndicators[`rsi${String(p.period)}`];
    if (rsi === undefined || prev === undefined) return null;

    const evidence = {
      rsi,
      prev,
      oversold: p.oversold,
      overbought: p.overbought,
    };
    if (prev <= p.oversold && rsi > p.oversold) {
      return { direction: "BULLISH", evidence };
    }
    if (prev >= p.overbought && rsi < p.overbought) {
      return { direction: "BEARISH", evidence };
    }
    return null;
  },
};
