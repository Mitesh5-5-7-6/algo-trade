import { z } from "zod";
import {
  EntityIdSchema,
  PriceSchema,
  QuantitySchema,
  SymbolSchema,
  TimestampSchema,
  TradeModeSchema,
} from "./primitives.js";

/** Orders are directional instructions — HOLD never reaches the Order Manager. */
export const OrderSideSchema = z.enum(["BUY", "SELL"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(["MARKET", "LIMIT"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

/**
 * The order state machine (plan/12 §5). Transitions are one-way; terminal
 * states are immutable — enforced by the Order Manager, recorded here.
 */
export const OrderStatusSchema = z.enum([
  "PLACED",
  "PENDING",
  "FILLED",
  "REJECTED",
  "CANCELLED",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const ORDER_TERMINAL_STATUSES = [
  "FILLED",
  "REJECTED",
  "CANCELLED",
] as const satisfies readonly OrderStatus[];

/** The persisted execution record (plan/07 `orders`); unique on signalId (plan/12 §6). */
export const OrderSchema = z.object({
  orderId: EntityIdSchema,
  signalId: EntityIdSchema,
  strategyId: EntityIdSchema,
  symbol: SymbolSchema,
  side: OrderSideSchema,
  qty: QuantitySchema,
  type: OrderTypeSchema,
  /** Limit price; absent for MARKET orders. */
  price: PriceSchema.optional(),
  status: OrderStatusSchema,
  mode: TradeModeSchema,
  brokerOrderId: z.string().optional(),
  slippage: z.number().nonnegative().optional(),
  charges: z.number().nonnegative().optional(),
  filledPrice: PriceSchema.optional(),
  filledAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
});
export type Order = z.infer<typeof OrderSchema>;
