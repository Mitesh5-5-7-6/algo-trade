import { z } from "zod";
import {
  DataProvenanceSchema,
  EntryMarketContextSchema,
  ExitReasonSchema,
} from "./trade.js";
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
  /**
   * The strategy's version at the moment of the decision (design §5.4 Q4).
   *
   * Optional, and absence means a record written before versions existed —
   * the same reason `source` was defaulted rather than required. A required
   * field would throw on the first read of anything already in Mongo.
   *
   * Copied forward rather than referenced. Each of Signal, Order and Trade
   * is written at a different moment by a different component, and a trade
   * whose version had to be looked up through its order would lose it the
   * moment orders are pruned.
   */
  strategyVersion: z.string().min(1).optional(),
  symbol: SymbolSchema,
  side: OrderSideSchema,
  qty: QuantitySchema,
  type: OrderTypeSchema,
  /** Limit price; absent for MARKET orders. */
  price: PriceSchema.optional(),
  /** Stop loss trigger price (if a bracket/cover order). */
  stopLoss: PriceSchema.optional(),
  /** Take profit target price (if a bracket order). */
  takeProfit: PriceSchema.optional(),
  /**
   * The entry decision's bar and its volume flags, copied from the signal
   * (design §2, drifts 1 and 3). Persisted, not just forwarded: a live fill
   * is published from the stored order, possibly after a restart.
   */
  dataProvenance: DataProvenanceSchema.optional(),
  marketContext: EntryMarketContextSchema.optional(),
  /** Copied from the signal, so the fill can report it without a join. */
  exitReason: ExitReasonSchema.optional(),
  status: OrderStatusSchema,
  mode: TradeModeSchema,
  brokerOrderId: z.string().optional(),
  slippage: z.number().nonnegative().optional(),
  charges: z.number().nonnegative().optional(),
  filledPrice: PriceSchema.optional(),
  filledAt: TimestampSchema.optional(),
  /**
   * Why the broker refused it, in the broker's own words.
   *
   * There was nowhere to record this, so the reason was discarded at the very
   * moment it was learned. A REJECTED row with no explanation is the hardest
   * kind of failure to chase — the answer existed, briefly, and was dropped.
   */
  rejectReason: z.string().optional(),
  /** The broker's error code, when it supplied one. */
  rejectCode: z.string().optional(),
  createdAt: TimestampSchema,
});
export type Order = z.infer<typeof OrderSchema>;
