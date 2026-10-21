import { z } from "zod";
import type { DetectionResult, PatternDetector } from "./contract.js";

export const VwapReclaimParamsSchema = z.object({
  /** How far beyond VWAP the close must sit, as a fraction of price. */
  bufferPct: z.number().min(0).max(0.05).default(0.0005),
});
export type VwapReclaimParams = z.infer<typeof VwapReclaimParamsSchema>;

/**
 * Price crosses back through VWAP — the session's volume-weighted fair value.
 *
 * The buffer exists because a close sitting exactly on VWAP is noise, and
 * without it this detector would fire repeatedly while price oscillates around
 * the line. A pattern that fires ten times in a chop is not a pattern; it is a
 * way of inflating a sample size.
 *
 * **Volume-based** (Phase 5 D3): VWAP weighs every bar since the session
 * opened by its volume, so one untrusted bar since the open taints every VWAP
 * after it. It declares those bars, and the registry declines on any that is
 * not REAL. Yesterday's bars are not in its window — VWAP resets at the bell.
 */
export const vwapReclaim: PatternDetector<VwapReclaimParams> = {
  patternId: "VWAP_RECLAIM",
  detectorVersion: "1.0.0",
  definition:
    "The close crosses from below VWAP to above it by more than a buffer " +
    "(bullish), or from above to below (bearish).",
  paramsSchema: VwapReclaimParamsSchema,
  requiredIndicators: () => [{ kind: "vwap" }],
  warmupBars: () => 2,
  volumeBars: (context) =>
    context.candles.filter((bar) => bar.ts >= context.sessionOpenTs),

  detect(context, p): DetectionResult | null {
    const vwap = context.indicators["vwap"];
    const prevVwap = context.previousIndicators["vwap"];
    if (vwap === undefined || prevVwap === undefined) return null;

    const prevBar = context.candles.at(-2);
    if (prevBar === undefined) return null;

    const close = context.candle.close;
    const buffer = close * p.bufferPct;
    const evidence = {
      close,
      vwap,
      prevClose: prevBar.close,
      prevVwap,
      buffer,
    };

    if (prevBar.close <= prevVwap && close > vwap + buffer) {
      return { direction: "BULLISH", evidence };
    }
    if (prevBar.close >= prevVwap && close < vwap - buffer) {
      return { direction: "BEARISH", evidence };
    }
    return null;
  },
};
