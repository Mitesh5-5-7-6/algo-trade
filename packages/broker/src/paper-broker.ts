import type {
  BrokerFill,
  BrokerOrderRequest,
  BrokerOrderStatus,
  ExecutionOutcome,
  OrderStatus,
  OrderUpdate,
} from "@neelkanth/core";
import type { Broker } from "./broker.js";
import { applySlippage, type SlippageModel } from "./slippage.js";
import {
  computeCharges,
  DEFAULT_CHARGES,
  type ChargeConfig,
} from "./charges.js";

export interface PaperBrokerDeps {
  /** Live price from `hot:price:{symbol}`; null when the feed has no price. */
  readPrice(symbol: string): Promise<number | null>;
  /** Whether the market session is open (`hot:session`). */
  readSessionOpen(): Promise<boolean>;
  slippage?: SlippageModel;
  charges?: ChargeConfig;
  now?: () => number;
  nextBrokerOrderId?: () => string;
}

/**
 * The Paper Broker (plan/11): one implementation of the `Broker` interface that
 * **simulates fills** using the current market price, a slippage model, and a
 * charge model — no real capital. In Phase 1 the whole pipeline executes
 * against it. Because it sits behind the same interface as FYERS and everything
 * downstream of a fill is the same projection, a strategy that behaves on paper
 * behaves the same live (plan/11 §2).
 *
 * It assumes a **risk-approved** order (plan/11 §3) — it does not re-validate
 * capital or exposure. It never updates positions (that's the projection
 * chain's job). And it never invents a fill price: no `hot:price` ⇒ reject,
 * not a fabricated fill (plan/11 §9).
 *
 * The market-data half of the interface is inert here: in paper mode the real
 * data feed is FYERS (plan/19 §2), wired separately at the composition root.
 */
export class PaperBroker implements Broker {
  private readonly deps: PaperBrokerDeps;
  private readonly slippage: SlippageModel;
  private readonly charges: ChargeConfig;
  private readonly now: () => number;
  private readonly known = new Map<string, OrderStatus>();
  private readonly orderUpdateHandlers: ((u: OrderUpdate) => void)[] = [];
  private seq = 0;

  constructor(deps: PaperBrokerDeps) {
    this.deps = deps;
    this.slippage = deps.slippage ?? { kind: "percent", pct: 0.0005 };
    this.charges = deps.charges ?? DEFAULT_CHARGES;
    this.now = deps.now ?? (() => Date.now());
  }

  async execute(order: BrokerOrderRequest): Promise<ExecutionOutcome> {
    // Validate as a real broker would, so invalid-order handling is exercised
    // in Phase 1 rather than discovered in Phase 3 (plan/11 §4.1).
    if (!(await this.deps.readSessionOpen())) {
      return this.reject(order.clientOrderId, "market is closed");
    }
    const price = await this.deps.readPrice(order.symbol);
    if (price === null) {
      // No price ⇒ cannot fill; never fabricate one (plan/11 §9).
      return this.reject(order.clientOrderId, "no current price available");
    }

    if (order.type === "LIMIT") {
      if (order.price === undefined) {
        return this.reject(order.clientOrderId, "limit order without a price");
      }
      const satisfied =
        order.side === "BUY" ? price <= order.price : price >= order.price;
      if (!satisfied) {
        // Held pending until price crosses (plan/11 §4); no monitoring yet.
        this.known.set(order.clientOrderId, "PENDING");
        return {
          status: "PENDING",
          clientOrderId: order.clientOrderId,
          brokerOrderId: this.nextId(),
        };
      }
      return this.fill(order, order.price, 0);
    }

    // MARKET: fill at the slippage-adjusted last price.
    const filledPrice = applySlippage(price, order.side, this.slippage);
    return this.fill(order, filledPrice, Math.abs(filledPrice - price));
  }

  cancel(clientOrderId: string): Promise<void> {
    this.known.set(clientOrderId, "CANCELLED");
    return Promise.resolve();
  }

  status(clientOrderId: string): Promise<BrokerOrderStatus> {
    const status = this.known.get(clientOrderId);
    return Promise.resolve(
      status === undefined
        ? { clientOrderId, found: false }
        : { clientOrderId, found: true, status },
    );
  }

  onOrderUpdate(handler: (update: OrderUpdate) => void): void {
    this.orderUpdateHandlers.push(handler);
  }

  // --- Market data: inert in paper mode (real feed is FYERS, plan/19 §2) ---
  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(): Promise<void> {
    return Promise.resolve();
  }
  onData(): void {
    /* no-op: paper produces no market data */
  }
  onConnectionChange(): void {
    /* no-op: paper execution has no connection to lose */
  }

  // --- internals ---
  private fill(
    order: BrokerOrderRequest,
    filledPrice: number,
    slippage: number,
  ): ExecutionOutcome {
    const charges = computeCharges(
      filledPrice,
      order.qty,
      order.side,
      this.charges,
    );
    this.known.set(order.clientOrderId, "FILLED");
    const fill: BrokerFill = {
      clientOrderId: order.clientOrderId,
      brokerOrderId: this.nextId(),
      filledPrice,
      filledQty: order.qty,
      slippage,
      charges,
      filledAt: this.now(),
    };
    return { status: "FILLED", fill };
  }

  private reject(clientOrderId: string, reason: string): ExecutionOutcome {
    this.known.set(clientOrderId, "REJECTED");
    return { status: "REJECTED", clientOrderId, reason };
  }

  private nextId(): string {
    if (this.deps.nextBrokerOrderId) return this.deps.nextBrokerOrderId();
    this.seq += 1;
    return `paper-${String(this.seq)}`;
  }
}
