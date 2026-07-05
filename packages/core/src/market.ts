import { z } from "zod";
import {
  CandleIntervalSchema,
  PriceSchema,
  SymbolSchema,
  TimestampSchema,
} from "./primitives.js";

/**
 * Normalized market-data shapes. Nothing downstream of the Market Data Engine
 * ever sees a broker wire format (plan/17 §2).
 */

export const TickSchema = z.object({
  symbol: SymbolSchema,
  ltp: PriceSchema,
  volume: z.number().nonnegative(),
  bid: PriceSchema.optional(),
  ask: PriceSchema.optional(),
  ts: TimestampSchema,
});
export type Tick = z.infer<typeof TickSchema>;

export const CandleSchema = z.object({
  symbol: SymbolSchema,
  interval: CandleIntervalSchema,
  open: PriceSchema,
  high: PriceSchema,
  low: PriceSchema,
  close: PriceSchema,
  volume: z.number().nonnegative(),
  /** Bucket start time (plan/17 §5). */
  ts: TimestampSchema,
});
export type Candle = z.infer<typeof CandleSchema>;

/** Session phase written to hot:session by the session manager (plan/17 §6). */
export const SessionPhaseSchema = z.enum(["pre-open", "open", "closed"]);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;
