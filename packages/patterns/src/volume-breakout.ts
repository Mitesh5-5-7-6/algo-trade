import { z } from "zod";
import type { DetectionResult, PatternDetector } from "./contract.js";
import { highestHigh, lowestLow, mean, priorBars } from "./shared.js";

export const VolumeBreakoutParamsSchema = z.object({
  /** Bars whose high/low define the level being broken. */
  lookback: z.number().int().positive().default(20),
  /** Volume must exceed this multiple of the recent average. */
  volumeMultiple: z.number().positive().default(1.5),
});
export type VolumeBreakoutParams = z.infer<typeof VolumeBreakoutParamsSchema>;

/**
 * A range break that volume confirms.
 *
 * Both conditions matter, and the volume half is why this is a separate
 * pattern from a plain breakout: a break on thin volume is the structure most
 * likely to fail, and pooling the two would hide exactly the distinction the
 * matrix is meant to surface.
 *
 * **Volume quality is the caller's problem.** Index symbols report no
 * meaningful volume (ARCHITECTURE_DECISION §20.6), and this detector cannot
 * tell a genuine zero from an absent feed — it simply will not fire, which is
 * the safe direction. Running it on an index and reading "no volume breakouts
 * occurred" as a market fact would be the mistake.
 */
export const volumeBreakout: PatternDetector<VolumeBreakoutParams> = {
  patternId: "VOLUME_BREAKOUT",
  detectorVersion: "1.0.0",
  definition:
    "The close breaks the highest high (bullish) or lowest low (bearish) of " +
    "the prior N bars, on volume above a multiple of their average.",
  paramsSchema: VolumeBreakoutParamsSchema,
  requiredIndicators: () => [],
  warmupBars: (p) => p.lookback + 1,

  detect(context, p): DetectionResult | null {
    const prior = priorBars(context.candles, p.lookback);
    if (prior.length < p.lookback) return null;

    const averageVolume = mean(prior.map((bar) => bar.volume));
    // No usable volume: decline rather than guess. See the note above.
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
