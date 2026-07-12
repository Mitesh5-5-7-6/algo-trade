import type { OrderSide, PositionSide, PositionStatus } from "@neelkanth/core";

/** A fill applied to a position (the money-relevant fields of ORDER_FILLED). */
export interface Fill {
  side: OrderSide;
  qty: number;
  price: number;
  charges: number;
}

/** The derived state of a position — the two-number summary plus realized PnL. */
export interface PositionState {
  side: PositionSide;
  qty: number;
  avgEntryPrice: number;
  realizedPnl: number;
  status: PositionStatus;
}

const openSideFor = (fillSide: OrderSide): PositionSide =>
  fillSide === "BUY" ? "LONG" : "SHORT";

/** Does this fill add to (rather than reduce) the position? */
export function isSameSide(position: PositionState, fill: Fill): boolean {
  return (
    (position.side === "LONG" && fill.side === "BUY") ||
    (position.side === "SHORT" && fill.side === "SELL")
  );
}

/**
 * Apply one fill to a position, deriving the new state with fixed formulas
 * (plan/13 §3). Sign convention: `qty` is positive, `side` carries direction.
 * Charges are subtracted into realized PnL at EVERY fill, entry and exit
 * (plan/13 §3) — the operator's question is "what did this trade actually
 * make?", and an answer that ignores costs is the paper-trading lie.
 *
 * For an opposite-side fill this reduces or closes ONLY up to the held
 * quantity; a fill larger than the position (a reversal) closes it here and the
 * engine opens the remainder as a new position, so position history stays clean.
 */
export function applyFill(
  current: PositionState | null,
  fill: Fill,
): PositionState {
  // Open a fresh position.
  if (current === null || current.status === "CLOSED") {
    return {
      side: openSideFor(fill.side),
      qty: fill.qty,
      avgEntryPrice: fill.price,
      realizedPnl: -fill.charges, // entry charges are a realized cost
      status: "OPEN",
    };
  }

  // Add to the position: quantity-weighted mean entry (plan/13 §3).
  if (isSameSide(current, fill)) {
    const newQty = current.qty + fill.qty;
    return {
      side: current.side,
      qty: newQty,
      avgEntryPrice:
        (current.qty * current.avgEntryPrice + fill.qty * fill.price) / newQty,
      realizedPnl: current.realizedPnl - fill.charges,
      status: "OPEN",
    };
  }

  // Reduce / close: realize PnL on the closed quantity against the average
  // entry; avgEntry is unchanged on a reduce (plan/13 §3).
  const closedQty = Math.min(fill.qty, current.qty);
  const direction = current.side === "LONG" ? 1 : -1;
  const realizedPnl =
    current.realizedPnl +
    direction * (fill.price - current.avgEntryPrice) * closedQty -
    fill.charges;
  const remaining = current.qty - closedQty;
  return {
    side: current.side,
    qty: remaining,
    avgEntryPrice: current.avgEntryPrice,
    realizedPnl,
    status: remaining === 0 ? "CLOSED" : "OPEN",
  };
}

/** Mark-to-market of an open position at the current price (plan/13 §5). */
export function unrealizedPnl(
  position: Pick<PositionState, "side" | "qty" | "avgEntryPrice">,
  currentPrice: number,
): number {
  const direction = position.side === "LONG" ? 1 : -1;
  return direction * (currentPrice - position.avgEntryPrice) * position.qty;
}
