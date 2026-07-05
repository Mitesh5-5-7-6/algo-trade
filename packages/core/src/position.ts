import { z } from "zod";
import {
  EntityIdSchema,
  PriceSchema,
  SymbolSchema,
  TimestampSchema,
  TradeModeSchema,
} from "./primitives.js";

/** Quantities are positive; side carries direction (plan/13 §3 sign convention). */
export const PositionSideSchema = z.enum(["LONG", "SHORT"]);
export type PositionSide = z.infer<typeof PositionSideSchema>;

export const PositionStatusSchema = z.enum(["OPEN", "CLOSED"]);
export type PositionStatus = z.infer<typeof PositionStatusSchema>;

/** The persisted holding record (plan/07 `positions`). */
export const PositionSchema = z.object({
  positionId: EntityIdSchema,
  symbol: SymbolSchema,
  strategyId: EntityIdSchema,
  side: PositionSideSchema,
  /** 0 only when CLOSED. */
  qty: z.number().int().nonnegative(),
  avgEntryPrice: PriceSchema,
  status: PositionStatusSchema,
  realizedPnl: z.number(),
  unrealizedPnl: z.number(),
  openedAt: TimestampSchema,
  closedAt: TimestampSchema.optional(),
  mode: TradeModeSchema,
});
export type Position = z.infer<typeof PositionSchema>;
