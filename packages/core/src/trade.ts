import { z } from "zod";
import {
  EntityIdSchema,
  PriceSchema,
  QuantitySchema,
  SymbolSchema,
  TimestampSchema,
  TradeModeSchema,
} from "./primitives.js";
import { PositionSideSchema } from "./position.js";

/**
 * Why a trade ended (plan/13 §6, ARCHITECTURE_DECISION §9.2).
 *
 * Recorded because "it closed" is not an outcome anyone can learn from. A stop
 * and a session square-off at the same price are the same number and entirely
 * different events: one is the strategy's own risk rule working, the other is
 * the clock running out on a position that never resolved.
 */
export const ExitReasonSchema = z.enum([
  "STOP_LOSS",
  "TAKE_PROFIT",
  "STRATEGY_EXIT",
  "TIME_EXIT",
  "SESSION_CLOSE",
  "MANUAL_EMERGENCY",
  "BROKER_RECONCILIATION",
]);
export type ExitReason = z.infer<typeof ExitReasonSchema>;

/**
 * The completed Trade — the canonical outcome primitive.
 *
 * A signal is not an outcome. An entry is not an outcome. Research labels
 * `Pattern → Strategy → Outcome`, and this record is the only thing that can
 * supply the third term: what a single decision actually earned, and why it
 * ended.
 *
 * Deliberately NOT stored in `trade_logs`. That collection carries a 90-day
 * TTL, and completed trades are research evidence — evidence that expires is
 * a dataset that quietly shrinks under whoever is studying it
 * (ARCHITECTURE_DECISION §10.4). Trades live in `trades`, untimed.
 *
 * Costs are kept SEPARATE from the result rather than folded into it. The
 * position engine's `realizedPnl` subtracts charges as it goes, which makes
 * "what did this earn before costs?" unrecoverable — and cost sensitivity is
 * one of the things research must be able to measure.
 */
export const TradeSchema = z.object({
  tradeId: EntityIdSchema,
  strategyId: EntityIdSchema,
  /** The strategy's version at entry, so a later edit cannot rewrite history. */
  strategyVersion: z.string().min(1).optional(),
  symbol: SymbolSchema,
  side: PositionSideSchema,
  /** Paper or live — an audit trail that never infers itself from context. */
  mode: TradeModeSchema,

  // --- Entry: always present. A trade exists because something filled. ---
  entryOrderId: EntityIdSchema,
  entrySignalId: EntityIdSchema.optional(),
  entryTime: TimestampSchema,
  entryPrice: PriceSchema,
  /**
   * The largest size this trade ever held.
   *
   * "How big was this trade?" is the research question, and the quantity
   * remaining on a closed trade is always zero — so the two cannot be the same
   * field.
   */
  quantity: QuantitySchema,
  /** Still open. Zero once the trade is closed; drives the reduce/close split. */
  openQuantity: z.number().int().nonnegative().default(0),

  // --- Exit: absent while the trade is open. ---
  exitOrderId: EntityIdSchema.optional(),
  exitSignalId: EntityIdSchema.optional(),
  exitTime: TimestampSchema.optional(),
  exitPrice: PriceSchema.optional(),
  exitReason: ExitReasonSchema.optional(),

  /**
   * OPEN until the closing fill is known.
   *
   * A trade is not created optimistically at signal time: `PENDING` is not
   * `FILLED`, and a trade that never filled is not a trade. It opens on the
   * entry fill and closes on the exit fill.
   */
  status: z.enum(["OPEN", "CLOSED"]),

  // --- Result: only meaningful once CLOSED. ---
  /** Before costs: `(exit − entry) × qty`, signed by side. */
  grossPnl: z.number().optional(),
  /** Brokerage, taxes and fees across both legs. */
  charges: z.number().nonnegative().default(0),
  /** Execution shortfall across both legs, kept rather than discarded. */
  slippage: z.number().nonnegative().default(0),
  /** `grossPnl − charges`. Stored, not derived, so a cost-model change cannot silently restate history. */
  netPnl: z.number().optional(),

  /**
   * The position this trade's fills built.
   *
   * With this, `Signal → Order → Trade → Position` is navigable from the trade
   * — which is the direction research reads. A reverse pointer on the order
   * would need a second write after the fill lands, adding a failure mode for
   * a link already reachable.
   */
  positionId: EntityIdSchema.optional(),

  // --- Research linkage (populated as later phases land). ---
  /** The pattern active at entry, with the detector version that found it. */
  entryPatternId: z.string().min(1).optional(),
  /** Regime, volatility and news context at entry. */
  marketContext: z.record(z.string(), z.unknown()).optional(),
  /** Where the candles behind this trade came from. */
  dataProvenance: z.string().min(1).optional(),

  openedAt: TimestampSchema,
  closedAt: TimestampSchema.optional(),
});
export type Trade = z.infer<typeof TradeSchema>;

/**
 * Gross P&L for a round trip, signed by direction.
 *
 * Separate and pure so the arithmetic is testable without a database, and so
 * there is exactly one place where "which way does a SHORT make money" is
 * decided.
 */
export function grossPnlFor(
  side: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
  quantity: number,
): number {
  const direction = side === "LONG" ? 1 : -1;
  return direction * (exitPrice - entryPrice) * quantity;
}

/** Net of charges. Slippage is already reflected in the fill prices. */
export function netPnlFor(grossPnl: number, charges: number): number {
  return grossPnl - charges;
}

/** The money-relevant fields of a fill, as a trade consumes them. */
export interface TradeFill {
  orderId: string;
  signalId?: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  charges: number;
  slippage: number;
  filledAt: number;
  exitReason?: ExitReason;
}

/** What `applyTradeFill` produced: the trade, and any reversal remainder. */
export interface TradeFillResult {
  trade: Trade;
  /**
   * When an opposite fill exceeded the held quantity, the leftover that must
   * open a NEW trade — mirroring how the Position Engine splits a reversal so
   * history stays one-position-per-direction.
   */
  remainder: TradeFill | null;
}

/**
 * Apply one fill to a trade (plan/13 §3, mirrored for outcomes).
 *
 * **Gross P&L accumulates; it is not computed once at the end.** A trade may
 * be reduced in several legs at different prices, and
 * `(finalExit − entry) × qty` would silently misprice every one of those. Each
 * reducing fill therefore realises its own slice, and `grossPnl` is their sum.
 * For the ordinary one-in-one-out trade the two agree exactly.
 *
 * `quantity` records the largest size the trade ever held, not the size
 * remaining — "how big was this trade?" is the research question, and a closed
 * trade's remaining quantity is always zero.
 *
 * Pure, so the arithmetic is testable without an engine or a database, and so
 * there is one place where a reversal's split is decided.
 */
export function applyTradeFill(
  current: Trade | null,
  fill: TradeFill,
  context: {
    tradeId: string;
    strategyId: string;
    symbol: string;
    mode: Trade["mode"];
    /**
     * The position this fill built, when it is known.
     *
     * Set once, at open. Later fills spread the existing trade, so a closing
     * fill — by which time the position may already be gone from memory —
     * cannot blank it.
     */
    positionId?: string;
    /** Stamped at open so a later strategy edit cannot restate history (Q4). */
    strategyVersion?: string;
  },
): TradeFillResult {
  const open = current !== null && current.status === "OPEN" ? current : null;

  // No open trade: this fill starts one.
  if (open === null) {
    return {
      trade: TradeSchema.parse({
        tradeId: context.tradeId,
        strategyId: context.strategyId,
        symbol: context.symbol,
        mode: context.mode,
        side: fill.side === "BUY" ? "LONG" : "SHORT",
        entryOrderId: fill.orderId,
        ...(fill.signalId === undefined
          ? {}
          : { entrySignalId: fill.signalId }),
        entryTime: fill.filledAt,
        entryPrice: fill.price,
        ...(context.positionId === undefined
          ? {}
          : { positionId: context.positionId }),
        ...(context.strategyVersion === undefined
          ? {}
          : { strategyVersion: context.strategyVersion }),
        quantity: fill.qty,
        openQuantity: fill.qty,
        status: "OPEN",
        charges: fill.charges,
        slippage: fill.slippage,
        grossPnl: 0,
        openedAt: fill.filledAt,
      }),
      remainder: null,
    };
  }

  const addsToPosition =
    (open.side === "LONG" && fill.side === "BUY") ||
    (open.side === "SHORT" && fill.side === "SELL");

  // Adding: quantity-weighted mean entry, same as the position projection.
  if (addsToPosition) {
    const held = open.openQuantity;
    const newHeld = held + fill.qty;
    return {
      trade: TradeSchema.parse({
        ...open,
        entryPrice: (open.entryPrice * held + fill.price * fill.qty) / newHeld,
        quantity: Math.max(open.quantity, newHeld),
        openQuantity: newHeld,
        charges: open.charges + fill.charges,
        slippage: open.slippage + fill.slippage,
      }),
      remainder: null,
    };
  }

  // Reducing or closing. Only up to what is held; the excess is a reversal.
  const closingQty = Math.min(fill.qty, open.openQuantity);
  const excess = fill.qty - closingQty;
  const direction = open.side === "LONG" ? 1 : -1;
  const realised = direction * (fill.price - open.entryPrice) * closingQty;
  const grossPnl = (open.grossPnl ?? 0) + realised;
  const remainingQty = open.openQuantity - closingQty;
  const closed = remainingQty === 0;

  // A reversal is one broker order paying for two trades, so its cost belongs
  // to both (design §5.1 Q1). Charging it all to the closing leg — which is
  // what "remainder: charges 0" did — leaves the closing trade paying for an
  // entry it never made and the new trade appearing to enter for free. Both
  // figures are then wrong in opposite directions, and cost sensitivity is
  // exactly what D2 keeps costs separate to measure.
  const closingCharges = allocate(fill.charges, closingQty, fill.qty);
  const closingSlippage = allocate(fill.slippage, closingQty, fill.qty);
  const charges = open.charges + closingCharges;

  // The weighted mean of every exit leg, mirroring what the entry side above
  // already does when a position is added to (design §5.1 Q2). Overwriting
  // with the latest leg made `exitPrice` mean "the last tranche", so
  // `(exitPrice − entryPrice) × quantity` disagreed with `grossPnl` on any
  // trade that left in pieces — with nothing to say which was right.
  const exitedBefore = open.quantity - open.openQuantity;
  const exitedAfter = exitedBefore + closingQty;
  const exitPrice =
    exitedBefore > 0 && open.exitPrice !== undefined
      ? (open.exitPrice * exitedBefore + fill.price * closingQty) / exitedAfter
      : fill.price;

  const trade = TradeSchema.parse({
    ...open,
    openQuantity: remainingQty,
    grossPnl,
    charges,
    slippage: open.slippage + closingSlippage,
    netPnl: netPnlFor(grossPnl, charges),
    // `exitPrice` is the weighted mean of all legs; the other exit fields
    // describe the LATEST one, so a partially closed trade still says when it
    // was last touched and why.
    exitOrderId: fill.orderId,
    ...(fill.signalId === undefined ? {} : { exitSignalId: fill.signalId }),
    exitTime: fill.filledAt,
    exitPrice,
    ...(fill.exitReason === undefined ? {} : { exitReason: fill.exitReason }),
    ...(closed ? { status: "CLOSED", closedAt: fill.filledAt } : {}),
  });

  return {
    trade,
    remainder:
      excess > 0
        ? {
            ...fill,
            qty: excess,
            // The rest of the order's cost, by subtraction rather than by a
            // second rounding — so the two legs always sum to what the broker
            // actually charged.
            charges: fill.charges - closingCharges,
            slippage: fill.slippage - closingSlippage,
          }
        : null,
  };
}

/**
 * Split an order-level cost across the leg that closes and the leg that opens.
 *
 * Rounded to paise, because a cost carried at full float precision reconciles
 * against a broker contract note only by luck. The caller takes the remainder
 * by subtraction rather than rounding the second leg independently, which is
 * what keeps the invariant exact:
 *
 * ```text
 * closingTrade.charges + openingTrade.charges === originalFill.charges
 * ```
 *
 * A misallocated paisa is auditable. A cost that does not sum to the fill is
 * not, because nothing downstream can tell it was ever wrong.
 */
function allocate(total: number, part: number, whole: number): number {
  if (whole <= 0 || part >= whole) return total;
  return Math.round(total * (part / whole) * 100) / 100;
}
