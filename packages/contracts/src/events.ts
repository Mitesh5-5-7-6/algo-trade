import { z } from "zod";
import {
  CandleSchema,
  ContextSnapshotSchema,
  EntityIdSchema,
  OrderSideSchema,
  OrderTypeSchema,
  PositionSideSchema,
  PositionStatusSchema,
  PriceSchema,
  QuantitySchema,
  RiskCheckNameSchema,
  SignalSideSchema,
  ConfidenceSchema,
  SymbolSchema,
  TickSchema,
  TimestampSchema,
  TradeModeSchema,
} from "@neelkanth/core";

/**
 * The 14-event catalog (plan/09 §6). These constants are the ONLY way to name
 * an event — string literals at emit/subscribe sites are banned (plan/25 §3):
 * a typo'd channel name doesn't error, it silently talks to nobody.
 */
export const EVENT_NAMES = [
  "MARKET_TICK",
  "CANDLE_CLOSED",
  "INDICATORS_UPDATED",
  "SIGNAL_CREATED",
  "RISK_BLOCKED",
  "ORDER_PLACED",
  "ORDER_FILLED",
  "ORDER_REJECTED",
  "POSITION_UPDATED",
  "PNL_UPDATED",
  "BROKER_CONNECTED",
  "BROKER_DISCONNECTED",
  "MARKET_OPEN",
  "MARKET_CLOSE",
  "SYSTEM_ERROR",
] as const;

export const EventNameSchema = z.enum(EVENT_NAMES);
export type EventName = z.infer<typeof EventNameSchema>;

/** PnL scope: global, per-strategy, or per-symbol (plan/09 `PNL_UPDATED`, plan/13 §5). */
export const PnlScopeSchema = z.union([
  z.literal("global"),
  z.string().regex(/^strategy:.+$/),
  z.string().regex(/^symbol:.+$/),
]);
export type PnlScope = z.infer<typeof PnlScopeSchema>;

/**
 * Payload schemas, one per event, exactly as catalogued in plan/09 §6.
 * A producer and a consumer can never disagree about a field (plan/09 §3).
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  MARKET_TICK: TickSchema,

  CANDLE_CLOSED: CandleSchema,

  INDICATORS_UPDATED: z.object({
    symbol: SymbolSchema,
    interval: z.string().min(1),
    indicators: z.record(z.string(), z.number()),
    ts: TimestampSchema,
  }),

  SIGNAL_CREATED: z.object({
    signalId: EntityIdSchema,
    strategyId: EntityIdSchema,
    symbol: SymbolSchema,
    side: SignalSideSchema,
    confidence: ConfidenceSchema,
    contextSnapshot: ContextSnapshotSchema,
    ts: TimestampSchema,
  }),

  RISK_BLOCKED: z.object({
    signalId: EntityIdSchema,
    strategyId: EntityIdSchema,
    symbol: SymbolSchema,
    failedCheck: RiskCheckNameSchema,
    reason: z.string().min(1),
    ts: TimestampSchema,
  }),

  ORDER_PLACED: z.object({
    orderId: EntityIdSchema,
    signalId: EntityIdSchema,
    strategyId: EntityIdSchema,
    symbol: SymbolSchema,
    side: OrderSideSchema,
    qty: QuantitySchema,
    type: OrderTypeSchema,
    price: PriceSchema.optional(),
    mode: TradeModeSchema,
    ts: TimestampSchema,
  }),

  /**
   * The broker refused the order, carrying ITS reason (plan/12 §5).
   *
   * Added because a rejection was previously invisible. The Order Manager
   * received the broker's message, wrote `status: REJECTED` without it, and
   * published nothing — so the operator saw a rejected order and could not
   * learn why from the database, the event stream, or the logs. That is
   * precisely the state you are in when an F&O order is refused for lot size,
   * margin, or product type: the diagnosis exists for one function call and is
   * then discarded.
   */
  ORDER_REJECTED: z.object({
    orderId: EntityIdSchema,
    signalId: EntityIdSchema,
    strategyId: EntityIdSchema,
    symbol: SymbolSchema,
    side: OrderSideSchema,
    qty: QuantitySchema,
    /** The broker's own message, passed through unedited. */
    reason: z.string().min(1),
    /** The broker's error code, when it supplied one. */
    code: z.string().optional(),
    mode: TradeModeSchema,
    ts: TimestampSchema,
  }),

  ORDER_FILLED: z.object({
    orderId: EntityIdSchema,
    /** Attributes the fill to its (strategy, symbol) position (plan/13 §3). */
    strategyId: EntityIdSchema,
    symbol: SymbolSchema,
    side: OrderSideSchema,
    qty: QuantitySchema,
    filledPrice: PriceSchema,
    slippage: z.number().nonnegative(),
    charges: z.number().nonnegative(),
    /**
     * The protective levels the order carried, forwarded so the position
     * projection can persist them (plan/13 §3). Without them on the fill, the
     * only record of a position's stop is the order that opened it — which no
     * consumer of this event reads.
     */
    stopLoss: PriceSchema.optional(),
    takeProfit: PriceSchema.optional(),
    filledAt: TimestampSchema,
    mode: TradeModeSchema,
    ts: TimestampSchema,
  }),

  POSITION_UPDATED: z.object({
    symbol: SymbolSchema,
    strategyId: EntityIdSchema,
    side: PositionSideSchema,
    qty: z.number().int().nonnegative(),
    avgEntryPrice: PriceSchema,
    status: PositionStatusSchema,
    realizedPnl: z.number(),
    ts: TimestampSchema,
  }),

  PNL_UPDATED: z.object({
    scope: PnlScopeSchema,
    realizedPnl: z.number(),
    unrealizedPnl: z.number(),
    ts: TimestampSchema,
  }),

  BROKER_CONNECTED: z.object({
    broker: z.string().min(1),
    mode: TradeModeSchema,
    ts: TimestampSchema,
  }),

  BROKER_DISCONNECTED: z.object({
    broker: z.string().min(1),
    mode: TradeModeSchema,
    reason: z.string().min(1),
    ts: TimestampSchema,
  }),

  MARKET_OPEN: z.object({
    exchange: z.string().min(1),
    session: z.string().min(1),
    ts: TimestampSchema,
  }),

  MARKET_CLOSE: z.object({
    exchange: z.string().min(1),
    session: z.string().min(1),
    ts: TimestampSchema,
  }),

  SYSTEM_ERROR: z.object({
    source: z.string().min(1),
    level: z.enum(["error", "fatal"]),
    message: z.string().min(1),
    context: z.record(z.string(), z.unknown()),
    ts: TimestampSchema,
  }),
} as const satisfies Record<EventName, z.ZodTypeAny>;

export type EventPayload<N extends EventName> = z.infer<
  (typeof EVENT_PAYLOAD_SCHEMAS)[N]
>;
