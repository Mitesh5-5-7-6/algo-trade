import type {
  BrokerConnectionState,
  BrokerOrderRequest,
  BrokerOrderStatus,
  ExecutionOutcome,
  OrderUpdate,
} from "@neelkanth/core";

/**
 * The `Broker` interface (plan/19 §2): the single contract everything in the
 * system depends on instead of FYERS. Two implementations — `PaperBroker`
 * (plan/11) and `FyersBroker` (plan/19) — are selected once at the
 * composition root (plan/05 §3); no pipeline code branches on which one it
 * holds. This is what makes going live a swap, not a rewrite (plan/02 §2.4).
 *
 * The interface has two duties, each consumed by a different engine:
 *  - Execution — the Order Manager (plan/12) calls `execute`/`cancel`/`status`
 *    and subscribes to `onOrderUpdate`.
 *  - Market data — the Market Data Engine (plan/17) drives `connect`/
 *    `subscribe` and consumes `onData`/`onConnectionChange`. Data messages are
 *    delivered RAW; normalization is the Market Data Engine's job (plan/19 §4).
 */
export interface Broker {
  // --- Execution (plan/12) ---

  /**
   * Submit a risk-approved order (plan/12 §4). Returns the outcome known at
   * submission: FILLED (immediate, typical for paper MARKET), PENDING
   * (accepted, fill arrives via `onOrderUpdate` — typical live), or REJECTED.
   * Must carry the caller's `clientOrderId` through (plan/19 §5).
   */
  execute(order: BrokerOrderRequest): Promise<ExecutionOutcome>;

  /** Cancel a pending order (e.g. an unfilled limit) by our reference. */
  cancel(clientOrderId: string): Promise<void>;

  /**
   * The broker's current view of an order — the reconcile half of
   * reconcile-then-decide after an unknown outcome (plan/12 §8). `found:false`
   * is the only thing that licenses a safe resubmit.
   */
  status(clientOrderId: string): Promise<BrokerOrderStatus>;

  /** Register the async fill/rejection/cancel stream (plan/19 §5). */
  onOrderUpdate(handler: (update: OrderUpdate) => void): void;

  // --- Market data (plan/17) ---

  /** Open the market-data connection (authenticates for live). */
  connect(): Promise<void>;

  /** Close the market-data connection. */
  disconnect(): Promise<void>;

  /**
   * Subscribe to the working set of symbols (plan/17 §7). Subscriptions do not
   * survive a reconnect and are re-established on `BROKER_CONNECTED`.
   */
  subscribe(symbols: readonly string[]): Promise<void>;

  /** Register the raw, untranslated data callback → Market Data Engine. */
  onData(handler: (raw: unknown) => void): void;

  /** Register the connection-state callback → BROKER_CONNECTED/DISCONNECTED. */
  onConnectionChange(handler: (state: BrokerConnectionState) => void): void;
}
