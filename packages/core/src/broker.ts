import { z } from "zod";
import {
  EntityIdSchema,
  PriceSchema,
  QuantitySchema,
  SymbolSchema,
  TimestampSchema,
} from "./primitives.js";
import {
  OrderSideSchema,
  OrderStatusSchema,
  OrderTypeSchema,
} from "./order.js";

/**
 * Broker contract shapes (plan/19 §2). These are the data types crossing the
 * boundary between the pipeline and *any* broker — Paper or FYERS. The
 * behavioral interface that consumes them lives in the `broker` package; the
 * shapes live here in `core` because they are the single source of truth for
 * shapes (plan/03 §6) and are validated where a live adapter produces them
 * (plan/19 §5 normalizes FYERS responses into these before handing them on).
 */

/**
 * What the Order Manager hands a broker to place (plan/12 §4 → plan/19 §5).
 * `clientOrderId` is our own order reference and is NON-NEGOTIABLE — it is the
 * key that makes `status(clientOrderId)` reconciliation possible after a
 * timeout (plan/12 §8, plan/19 §5). Without it a timed-out submission is
 * unresolvable.
 */
export const BrokerOrderRequestSchema = z.object({
  clientOrderId: EntityIdSchema,
  symbol: SymbolSchema,
  side: OrderSideSchema,
  qty: QuantitySchema,
  type: OrderTypeSchema,
  /** Required for LIMIT, absent for MARKET. */
  price: PriceSchema.optional(),
});
export type BrokerOrderRequest = z.infer<typeof BrokerOrderRequestSchema>;

/**
 * A confirmed fill. Charges + slippage are part of the fill because paper P&L
 * must reflect the real cost stack (plan/11 §2, §5); a live adapter fills
 * these from the broker's contract note.
 */
export const BrokerFillSchema = z.object({
  clientOrderId: EntityIdSchema,
  brokerOrderId: z.string().optional(),
  filledPrice: PriceSchema,
  filledQty: QuantitySchema,
  slippage: z.number().nonnegative(),
  charges: z.number().nonnegative(),
  filledAt: TimestampSchema,
});
export type BrokerFill = z.infer<typeof BrokerFillSchema>;

/**
 * The synchronous outcome of `execute()` — what is known at submission time.
 * A MARKET paper order fills immediately (FILLED); a live order is typically
 * accepted and fills asynchronously (PENDING → later `OrderUpdate`); either
 * can be REJECTED outright. This mirrors the order state machine (plan/12 §5)
 * and lets one interface serve both brokers (plan/11 §6).
 */
export const ExecutionOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("FILLED"),
    fill: BrokerFillSchema,
  }),
  z.object({
    status: z.literal("PENDING"),
    clientOrderId: EntityIdSchema,
    brokerOrderId: z.string(),
  }),
  z.object({
    status: z.literal("REJECTED"),
    clientOrderId: EntityIdSchema,
    /** Internal typed reason, translated from broker codes (plan/19 §5). */
    reason: z.string().min(1),
    code: z.string().optional(),
  }),
]);
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;

/**
 * An asynchronous order update (plan/19 §5): live fills/rejections/cancels
 * arrive after submission via the broker's order-update stream. Paper fires
 * these too for a PENDING (e.g. limit) order once price satisfies it.
 */
export const OrderUpdateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("FILLED"), fill: BrokerFillSchema }),
  z.object({
    status: z.literal("REJECTED"),
    clientOrderId: EntityIdSchema,
    reason: z.string().min(1),
    code: z.string().optional(),
  }),
  z.object({
    status: z.literal("CANCELLED"),
    clientOrderId: EntityIdSchema,
  }),
]);
export type OrderUpdate = z.infer<typeof OrderUpdateSchema>;

/**
 * The broker's view of an order, for reconcile-then-decide after an unknown
 * outcome (plan/12 §8). `found: false` is the verifiable "it does not exist
 * at the broker" that alone licenses a safe resubmit.
 */
export const BrokerOrderStatusSchema = z.object({
  clientOrderId: EntityIdSchema,
  found: z.boolean(),
  status: OrderStatusSchema.optional(),
  brokerOrderId: z.string().optional(),
});
export type BrokerOrderStatus = z.infer<typeof BrokerOrderStatusSchema>;

/** Connection state, surfaced as BROKER_CONNECTED/DISCONNECTED (plan/19 §4). */
export const BrokerConnectionStateSchema = z.enum([
  "connected",
  "connecting",
  "disconnected",
]);
export type BrokerConnectionState = z.infer<typeof BrokerConnectionStateSchema>;
