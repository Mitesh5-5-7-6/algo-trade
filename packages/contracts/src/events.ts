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

  ORDER_FILLED: z.object({
    orderId: EntityIdSchema,
    symbol: SymbolSchema,
    side: OrderSideSchema,
    qty: QuantitySchema,
    filledPrice: PriceSchema,
    slippage: z.number().nonnegative(),
    charges: z.number().nonnegative(),
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
