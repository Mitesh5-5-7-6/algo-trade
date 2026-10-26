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

/**
 * One paper order as the broker recorded it (Phase 14 D3): what was asked,
 * how it ended, and — when it filled — at what price, quantity and cost.
 */
export interface PaperBookEntry {
  clientOrderId: string;
  brokerOrderId?: string | undefined;
  symbol: string;
  side: BrokerOrderRequest["side"];
  qty: number;
  type: BrokerOrderRequest["type"];
  price?: number | undefined;
  status: OrderStatus;
  filledPrice?: number | undefined;
  filledQty?: number | undefined;
  slippage?: number | undefined;
  charges?: number | undefined;
  filledAt?: number | undefined;
  reason?: string | undefined;
  recordedAt: number;
}

/**
 * Where the paper broker keeps its book, so it survives a restart (D3). An
 * entry is written before the outcome is reported: what the trading state
 * hears, the book already holds.
 */
export interface PaperBook {
  /** Write an entry, or merge into the one already kept for its order. */
  record(
    entry: Partial<PaperBookEntry> &
      Pick<PaperBookEntry, "clientOrderId" | "status" | "recordedAt">,
  ): Promise<void>;
  find(clientOrderId: string): Promise<PaperBookEntry | null>;
  findPending(symbol?: string): Promise<PaperBookEntry[]>;
}

export interface PaperBrokerDeps {
  /** Live price from `hot:price:{symbol}`; null when the feed has no price. */
  readPrice(symbol: string): Promise<number | null>;
  /** Whether the market session is open (`hot:session`). */
  readSessionOpen(): Promise<boolean>;
  slippage?: SlippageModel;
  charges?: ChargeConfig;
  now?: () => number;
  nextBrokerOrderId?: () => string;
  /** Where the book is kept; without one it lives in memory and a restart forgets it. */
  book?: PaperBook;
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
  private readonly pending = new Map<
    string,
    BrokerOrderRequest & { brokerOrderId: string }
  >();
  private readonly orderUpdateHandlers: ((u: OrderUpdate) => void)[] = [];
  private pendingWork: Promise<void> = Promise.resolve();
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
      return this.reject(order, "market is closed");
    }
    const price = await this.deps.readPrice(order.symbol);
    if (price === null) {
      // No price ⇒ cannot fill; never fabricate one (plan/11 §9).
      return this.reject(order, "no current price available");
    }

    if (order.type === "LIMIT") {
      if (order.price === undefined) {
        return this.reject(order, "limit order without a price");
      }
      const satisfied =
        order.side === "BUY" ? price <= order.price : price >= order.price;
      if (!satisfied) {
        // The runtime watches this order on subsequent normalized ticks.
        const brokerOrderId = this.nextId();
        await this.keep(order, { status: "PENDING", brokerOrderId });
        this.pending.set(order.clientOrderId, { ...order, brokerOrderId });
        return {
          status: "PENDING",
          clientOrderId: order.clientOrderId,
          brokerOrderId,
        };
      }
      return this.fill(order, order.price, 0);
    }

    // MARKET: fill at the slippage-adjusted last price.
    const filledPrice = applySlippage(price, order.side, this.slippage);
    return this.fill(order, filledPrice, Math.abs(filledPrice - price));
  }

  async cancel(clientOrderId: string): Promise<void> {
    await this.serializePendingWork(async () => {
      const kept = await this.deps.book?.find(clientOrderId);
      const pending = this.pending.get(clientOrderId);
      if (kept?.status === "PENDING" || pending !== undefined) {
        await this.deps.book?.record({
          ...(kept ?? pending),
          clientOrderId,
          status: "CANCELLED",
          recordedAt: this.now(),
        });
        this.pending.delete(clientOrderId);
        this.known.set(clientOrderId, "CANCELLED");
        this.publishOrderUpdate({ status: "CANCELLED", clientOrderId });
        return;
      }
      if (kept !== undefined && kept !== null) return;
      if (this.deps.book !== undefined) return;
      this.known.set(clientOrderId, "CANCELLED");
    });
  }

  /** Process pending paper LIMIT orders against a normalized market tick. */
  async onMarketTick(tick: {
    symbol: string;
    ltp: number;
    ts: number;
  }): Promise<void> {
    await this.serializePendingWork(async () => {
      for (const order of await this.pendingOrders(tick.symbol)) {
        if (
          order.symbol !== tick.symbol ||
          order.price === undefined ||
          !this.isLimitSatisfied(order, tick.ltp)
        ) {
          continue;
        }
        const current = await this.deps.book?.find(order.clientOrderId);
        if (current !== undefined && current !== null) {
          if (current.status !== "PENDING") {
            this.pending.delete(order.clientOrderId);
            continue;
          }
          order.brokerOrderId = current.brokerOrderId ?? order.brokerOrderId;
        }
        const fillOrder: BrokerOrderRequest = {
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
          side: order.side,
          qty: order.qty,
          type: "LIMIT",
          price: order.price,
          ...(order.stopLoss === undefined ? {} : { stopLoss: order.stopLoss }),
          ...(order.takeProfit === undefined
            ? {}
            : { takeProfit: order.takeProfit }),
          ...(order.referencePrice === undefined
            ? {}
            : { referencePrice: order.referencePrice }),
        };
        const outcome = await this.fill(
          fillOrder,
          order.price,
          0,
          order.brokerOrderId,
          tick.ts,
        );
        this.pending.delete(order.clientOrderId);
        if (outcome.status === "FILLED") {
          this.publishOrderUpdate({
            status: "FILLED",
            fill: outcome.fill,
          });
        }
      }
    });
  }

  /** Cancel every still-pending LIMIT order at the end of the market session. */
  async expirePendingOrders(): Promise<void> {
    await this.serializePendingWork(async () => {
      for (const order of await this.pendingOrders()) {
        const current = await this.deps.book?.find(order.clientOrderId);
        if (current !== undefined && current !== null) {
          if (current.status !== "PENDING") {
            this.pending.delete(order.clientOrderId);
            continue;
          }
          order.brokerOrderId = current.brokerOrderId ?? order.brokerOrderId;
        }
        await this.deps.book?.record({
          clientOrderId: order.clientOrderId,
          status: "CANCELLED",
          reason: "session closed",
          recordedAt: this.now(),
        });
        this.pending.delete(order.clientOrderId);
        this.known.set(order.clientOrderId, "CANCELLED");
        this.publishOrderUpdate({
          status: "CANCELLED",
          clientOrderId: order.clientOrderId,
        });
      }
    });
  }

  private async pendingOrders(
    symbol?: string,
  ): Promise<Array<BrokerOrderRequest & { brokerOrderId: string }>> {
    const pending = new Map(
      [...this.pending].filter(
        ([, order]) => symbol === undefined || order.symbol === symbol,
      ),
    );
    for (const entry of (await this.deps.book?.findPending(symbol)) ?? []) {
      if (entry.type !== "LIMIT" || entry.price === undefined) continue;
      pending.set(entry.clientOrderId, {
        clientOrderId: entry.clientOrderId,
        symbol: entry.symbol,
        side: entry.side,
        qty: entry.qty,
        type: "LIMIT",
        price: entry.price,
        brokerOrderId: entry.brokerOrderId ?? entry.clientOrderId,
      });
    }
    return [...pending.values()];
  }

  private isLimitSatisfied(order: BrokerOrderRequest, price: number): boolean {
    if (order.price === undefined) return false;
    return order.side === "BUY" ? price <= order.price : price >= order.price;
  }

  private async serializePendingWork<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.pendingWork;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingWork = previous.then(() => gate);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private publishOrderUpdate(update: OrderUpdate): void {
    for (const handler of this.orderUpdateHandlers) handler(update);
  }

  /**
   * An order's status — from memory, or after a restart from the book, with
   * the fill's price, quantity, time and costs when it filled (D3), so the
   * Order Manager's reconciliation can settle it faithfully.
   */
  async status(clientOrderId: string): Promise<BrokerOrderStatus> {
    const kept = await this.deps.book?.find(clientOrderId);
    if (kept !== undefined && kept !== null)
      return {
        clientOrderId,
        found: true,
        status: kept.status,
        ...(kept.brokerOrderId === undefined
          ? {}
          : { brokerOrderId: kept.brokerOrderId }),
        ...(kept.filledPrice === undefined
          ? {}
          : { filledPrice: kept.filledPrice }),
        ...(kept.filledQty === undefined ? {} : { filledQty: kept.filledQty }),
        ...(kept.filledAt === undefined ? {} : { filledAt: kept.filledAt }),
        ...(kept.slippage === undefined ? {} : { slippage: kept.slippage }),
        ...(kept.charges === undefined ? {} : { charges: kept.charges }),
      };
    const status = this.known.get(clientOrderId);
    return status === undefined
      ? { clientOrderId, found: false }
      : { clientOrderId, found: true, status };
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
  /** Remember an order's outcome — in memory, and in the book when there is one. */
  private async keep(
    order: BrokerOrderRequest,
    outcome: Partial<PaperBookEntry> & Pick<PaperBookEntry, "status">,
  ): Promise<void> {
    await this.deps.book?.record({
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      type: order.type,
      ...(order.price === undefined ? {} : { price: order.price }),
      recordedAt: this.now(),
      ...outcome,
    });
    this.known.set(order.clientOrderId, outcome.status);
  }

  private async fill(
    order: BrokerOrderRequest,
    filledPrice: number,
    slippage: number,
    brokerOrderId = this.nextId(),
    filledAt = this.now(),
  ): Promise<ExecutionOutcome> {
    const charges = computeCharges(
      filledPrice,
      order.qty,
      order.side,
      this.charges,
    );
    const fill: BrokerFill = {
      clientOrderId: order.clientOrderId,
      brokerOrderId,
      filledPrice,
      filledQty: order.qty,
      slippage,
      charges,
      filledAt,
    };
    // Kept before it is reported: a crash after this line leaves a fill the
    // book knows and reconciliation can settle (D3).
    await this.keep(order, {
      status: "FILLED",
      ...(fill.brokerOrderId === undefined
        ? {}
        : { brokerOrderId: fill.brokerOrderId }),
      filledPrice: fill.filledPrice,
      filledQty: fill.filledQty,
      slippage: fill.slippage,
      charges: fill.charges,
      filledAt: fill.filledAt,
    });
    return { status: "FILLED", fill };
  }

  private async reject(
    order: BrokerOrderRequest,
    reason: string,
  ): Promise<ExecutionOutcome> {
    await this.keep(order, { status: "REJECTED", reason });
    return { status: "REJECTED", clientOrderId: order.clientOrderId, reason };
  }

  private nextId(): string {
    if (this.deps.nextBrokerOrderId) return this.deps.nextBrokerOrderId();
    this.seq += 1;
    return `paper-${String(this.seq)}`;
  }
}
