import { z } from "zod";

/**
 * Shared primitive schemas. Money-adjacent values never travel as naked,
 * unvalidated numbers (plan/25 §2) — every field below carries its constraint.
 */

/** Epoch milliseconds, exchange-anchored where the source provides it (plan/17 §4). */
export const TimestampSchema = z.number().int().positive();
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Instrument identifier in normalized internal form (e.g. "NSE:RELIANCE-EQ"). */
export const SymbolSchema = z.string().min(1);
export type InstrumentSymbol = z.infer<typeof SymbolSchema>;

/** Which broker executed/will execute — paper and live history share collections (plan/07 `orders.mode`). */
export const TradeModeSchema = z.enum(["paper", "live"]);
export type TradeMode = z.infer<typeof TradeModeSchema>;

/** Candle interval. 5m/15m are composed from 1m bars (plan/17 §5). */
export const CandleIntervalSchema = z.enum(["1m", "5m", "15m", "30m", "60m"]);
export type CandleInterval = z.infer<typeof CandleIntervalSchema>;

/** Confidence is the bounded channel the AI may modulate (plan/15 §6, plan/20 §2). */
export const ConfidenceSchema = z.number().min(0).max(1);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Positive integer share/contract quantity; side carries direction (plan/13 §3). */
export const QuantitySchema = z.number().int().positive();
export type Quantity = z.infer<typeof QuantitySchema>;

/** A traded price — strictly positive. */
export const PriceSchema = z.number().positive().finite();
export type Price = z.infer<typeof PriceSchema>;

/** Entity id (public/stable id, not the Mongo ObjectId — plan/07 §3). */
export const EntityIdSchema = z.string().min(1);
export type EntityId = z.infer<typeof EntityIdSchema>;
