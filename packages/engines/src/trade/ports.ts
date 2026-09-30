import type { Trade } from "@neelkanth/core";

/**
 * Infrastructure the Trade Engine reads and writes through, injected so the
 * engine stays infra-free and unit-testable (plan/05 §3).
 */
export interface TradePorts {
  /** Persist a new or updated trade. Sole owner of the `trades` collection. */
  saveTrade(trade: Trade): Promise<void>;
  /** Every open trade, for hydrating after a restart. */
  loadOpenTrades(): Promise<Trade[]>;
  /**
   * The trade a given order's fill was already folded into, if any.
   *
   * The durable half of idempotency (D5). The in-memory guard dies with the
   * process, so after a restart a redelivered CLOSING fill would find no open
   * trade and look exactly like a fresh opening fill on the other side — a
   * phantom trade the system never entered. Consulted only when memory does
   * not already know the order, so a warm session pays nothing.
   */
  findTradeByOrderId(orderId: string): Promise<Trade | null>;
  /**
   * The id of the position this fill built, or null.
   *
   * Synchronous and in-memory on purpose. The runtime awaits the Position
   * Engine before the Trade Engine on the same `ORDER_FILLED`, so by this
   * point the position exists — no read, and no race to lose.
   *
   * This is what makes `Signal → Order → Trade → Position` navigable from
   * the trade, which is the direction research reads (D4).
   */
  resolvePositionId(strategyId: string, symbol: string): string | null;
}
