import { z } from "zod";
import { SymbolSchema, TimestampSchema } from "./primitives.js";

/**
 * What kind of contract a symbol names. `EQUITY` is the cash market — one
 * share, no expiry. The other two are derivatives, and the difference matters
 * everywhere downstream: they trade in whole lots, they expire, and the money
 * a position costs is not `qty × price`.
 */
export const InstrumentKindSchema = z.enum(["EQUITY", "FUTURE", "OPTION"]);
export type InstrumentKind = z.infer<typeof InstrumentKindSchema>;

export const OptionTypeSchema = z.enum(["CE", "PE"]);
export type OptionType = z.infer<typeof OptionTypeSchema>;

/**
 * A tradable contract, as the broker defines it (plan/17 §7).
 *
 * This exists because the system was built for cash equity, where one unit
 * costs `price` and never expires — an assumption baked into position sizing.
 * Derivatives break it in three ways, and each field here is one of them:
 *
 *  - `lotSize` — orders must be a whole number of lots. NIFTY is 65,
 *    BANKNIFTY 30, SENSEX 20, and these CHANGE. They are read from the
 *    broker's symbol master, never hardcoded; a stale constant silently
 *    mis-sizes every order.
 *  - `expiry` — the contract dies. A configured symbol goes stale weekly, and
 *    an open position settles itself if not closed.
 *  - `strike` / `optionType` — an option is chosen relative to spot at signal
 *    time, so its symbol is computed, not configured.
 */
export const InstrumentSchema = z.object({
  /** The broker symbol, e.g. `NSE:NIFTY26AUGFUT`, `NSE:RELIANCE-EQ`. */
  symbol: SymbolSchema,
  kind: InstrumentKindSchema,
  /** Contract multiplier. Always 1 for equity. */
  lotSize: z.number().int().positive(),
  /** Minimum price increment; order prices must be a multiple of it. */
  tickSize: z.number().positive(),
  /** The instrument this derives from, e.g. `NIFTY`. Absent for equity. */
  underlying: z.string().min(1).optional(),
  /** Expiry instant. Absent for equity. */
  expiry: TimestampSchema.optional(),
  /** Strike price. Options only. */
  strike: z.number().positive().optional(),
  /** Call or put. Options only. */
  optionType: OptionTypeSchema.optional(),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

/**
 * The cash a position in `instrument` ties up, per lot.
 *
 * For an option BUYER this is exact: you pay the premium, times the lot size,
 * and that is the whole amount at risk. For a future it is the NOTIONAL, which
 * is emphatically not what you post — margin is a fraction of it — so callers
 * sizing futures must use a margin figure instead of this. Named to make that
 * misuse hard: it says notional, not cost.
 */
export function notionalPerLot(instrument: Instrument, price: number): number {
  return price * instrument.lotSize;
}

/**
 * Round `qty` DOWN to a whole number of lots.
 *
 * Down, never nearest: rounding up would spend more than the risk limit
 * allowed, which is the one direction a sizing function must never err in.
 * Returns 0 when a single lot does not fit — the caller must treat that as
 * "no capacity", not as a tiny order.
 */
export function floorToLots(qty: number, lotSize: number): number {
  if (lotSize <= 0) return 0;
  return Math.floor(qty / lotSize) * lotSize;
}

/** True once `now` is at or past expiry — the contract can no longer be traded. */
export function isExpired(instrument: Instrument, now: number): boolean {
  return instrument.expiry !== undefined && now >= instrument.expiry;
}
