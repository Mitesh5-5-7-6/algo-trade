import type { Order } from "@neelkanth/core";
import type { PublishFn } from "../market-data/ports.js";

/**
 * Infrastructure the Order Manager writes through, injected so it stays
 * infra-free and testable (plan/05 §3). The composition root implements these
 * with redis (kill flag) + db (`orders`); tests pass fakes. The Order Manager
 * is the sole writer of `orders` (plan/02 §8, plan/12 §7).
 */
export interface OrderPorts {
  /** The persisted kill/pause flag (`settings.tradingEnabled`, plan/12 §4.1). */
  readTradingEnabled(): Promise<boolean>;
  /**
   * Insert a new order as PLACED. Returns false when the unique `signalId`
   * index rejects it — the duplicate-execution backstop (plan/12 §6): one
   * order per signal is a database guarantee, not just an architectural one.
   */
  persistOrder(order: Order): Promise<boolean>;
  /** Patch an order toward a terminal state (plan/12 §5). */
  updateOrder(orderId: string, patch: Partial<Order>): Promise<void>;
  publish: PublishFn;
}
