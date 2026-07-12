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

/**
 * An end-of-day PnL snapshot (plan/07 `pnl_snapshots`, plan/13 §6): the durable
 * equity curve, one row per scope per trading day. `scope` is "global",
 * "strategy:{id}", or "symbol:{sym}".
 */
export const PnlSnapshotSchema = z.object({
  scope: z.string().min(1),
  /** IST trading date, "YYYY-MM-DD". */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  realizedPnl: z.number(),
  unrealizedPnl: z.number(),
  /** Day P&L equity value plotted on the dashboard curve. */
  equity: z.number(),
  tradeCount: z.number().int().nonnegative(),
  ts: TimestampSchema,
});
export type PnlSnapshot = z.infer<typeof PnlSnapshotSchema>;
