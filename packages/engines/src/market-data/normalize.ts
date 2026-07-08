import { z } from "zod";
import { TickSchema, type Tick } from "@neelkanth/core";

/**
 * A normalizer translates a broker's raw wire message into the internal Tick
 * shape (plan/17 §2). The normalization boundary is where broker quirks stop —
 * nothing downstream ever sees a broker payload, which is what makes the
 * broker interchangeable at the data level (plan/17 §2). Returns `null` for an
 * unparseable message so the engine can drop-and-log rather than propagate a
 * bad tick (plan/17 §8, honest absence).
 */
export type TickNormalizer = (raw: unknown) => Tick | null;

/**
 * The recorded-fixture raw tick shape (plan/11 §11 replay, plan/27 §4 golden
 * runs). Deliberately uses broker-ish field names distinct from `Tick` so the
 * mapping is a real translation, and tolerates extra fields (a live feed
 * carries many we ignore). The FYERS normalizer implements the same
 * `TickNormalizer` contract over FYERS's wire fields when credentials arrive.
 *
 * `vol` is the INCREMENTAL traded volume for this tick; a live normalizer
 * converts a broker's cumulative day-volume into deltas here, so the candle
 * aggregator can simply sum (plan/17 §5).
 */
export const FixtureRawTickSchema = z
  .object({
    sym: z.string().min(1),
    ltp: z.number(),
    vol: z.number(),
    bid: z.number().optional(),
    ask: z.number().optional(),
    /** Exchange timestamp, epoch ms (plan/17 §4 — market time, not receive time). */
    ts: z.number(),
  })
  .passthrough();

export const fixtureNormalizer: TickNormalizer = (raw) => {
  const parsed = FixtureRawTickSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const tick = {
    symbol: r.sym,
    ltp: r.ltp,
    volume: r.vol,
    ...(r.bid === undefined ? {} : { bid: r.bid }),
    ...(r.ask === undefined ? {} : { ask: r.ask }),
    ts: r.ts,
  };
  // The output is guaranteed a valid Tick or nothing — bad values (e.g. a
  // non-positive price) are dropped here, never handed downstream (plan/17 §8).
  const validated = TickSchema.safeParse(tick);
  return validated.success ? validated.data : null;
};
