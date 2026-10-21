import { z } from "zod";
import type { DetectionResult, PatternDetector } from "./contract.js";
import { highestHigh, lowestLow, mean, priorBars } from "./shared.js";

export const HighVolumeBreakoutParamsSchema = z.object({
  /** Bars whose high/low define the level being broken. */
  lookback: z.number().int().positive().default(20),
  /** Volume must exceed this multiple of the recent average. */
  volumeMultiple: z.number().positive().default(1.5),
});
export type HighVolumeBreakoutParams = z.infer<
  typeof HighVolumeBreakoutParamsSchema
>;

/**
 * A range break that volume confirms.
 *
 * Both conditions matter, and the volume half is why this is a separate
 * pattern from a plain breakout: a break on thin volume is the structure most
 * likely to fail, and pooling the two would hide exactly the distinction the
 * matrix is meant to surface.
 *
 * **No conclusion from untrusted volume** (ARCHITECTURE_DECISION §20.6,
 * Phase 5 D3). It declares its window — the prior `lookback` bars and the
 * bar judged — and the registry declines the bar if any of them is not REAL.
 * A sweep reports those declines, so "no volume breakouts occurred" is never
 * read off a series whose volume nobody trusts. An average of zero still
 * declines, as before: there is nothing to be a multiple of.
 */
export const highVolumeBreakout: PatternDetector<HighVolumeBreakoutParams> = {
  patternId: "HIGH_VOLUME_BREAKOUT",
  detectorVersion: "1.0.0",
  definition:
    "The close breaks the highest high (bullish) or lowest low (bearish) of " +
    "the prior N bars, on volume above a multiple of their average.",
  paramsSchema: HighVolumeBreakoutParamsSchema,
  requiredIndicators: () => [],
  warmupBars: (p) => p.lookback + 1,
  volumeBars: (context, p) => [
    ...priorBars(context.candles, p.lookback),
    context.candle,
  ],

  detect(context, p): DetectionResult | null {
    const prior = priorBars(context.candles, p.lookback);
    if (prior.length < p.lookback) return null;

    const averageVolume = mean(prior.map((bar) => bar.volume));
    // Nothing to be a multiple of: decline rather than guess.
    if (averageVolume <= 0) return null;

    const volume = context.candle.volume;
    const expanded = volume >= averageVolume * p.volumeMultiple;
    if (!expanded) return null;

    const priorHigh = highestHigh(prior);
    const priorLow = lowestLow(prior);
    const close = context.candle.close;
    const evidence = { close, priorHigh, priorLow, volume, averageVolume };

    if (close > priorHigh) return { direction: "BULLISH", evidence };
    if (close < priorLow) return { direction: "BEARISH", evidence };
    return null;
  },
};
