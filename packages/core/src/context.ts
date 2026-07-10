import { z } from "zod";
import { CandleIntervalSchema, SymbolSchema } from "./primitives.js";
import { CandleSchema, SessionPhaseSchema } from "./market.js";
import { PositionSchema } from "./position.js";

/**
 * The Market Context (plan/15 §3): one immutable snapshot per symbol, built by
 * the Strategy Engine and handed to `analyze()`. Every value is from the same
 * instant — a strategy never reads infrastructure directly, so it can't see a
 * price from now and indicators from a bar ago and act on the contradiction
 * (plan/15 §3). It's a plain object precisely so it's trivial to construct in
 * a test.
 */
export const SessionContextSchema = z.object({
  phase: SessionPhaseSchema,
  /** Minutes since the regular session opened; ≤ 0 before the bell. */
  minutesSinceOpen: z.number().int(),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

export const MarketContextSchema = z.object({
  symbol: SymbolSchema,
  interval: CandleIntervalSchema,
  /** The just-closed bar this decision is about. */
  candle: CandleSchema,
  /** A window of recent bars (oldest→newest, incl. `candle`) for pattern logic. */
  candles: z.array(CandleSchema),
  /** Ready indicator values only (plan/18 §4); keyed as e.g. "ema9". */
  indicators: z.record(z.string(), z.number()),
  session: SessionContextSchema,
  /** This strategy's open position for this symbol, or null when flat. */
  position: PositionSchema.nullable(),
  /** Clamped AI sentiment (plan/20); 0 = neutral/absent (Phase 1). */
  sentiment: z.number().min(-1).max(1),
});
export type MarketContext = z.infer<typeof MarketContextSchema>;
