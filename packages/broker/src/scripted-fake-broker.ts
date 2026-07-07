import type {
  BrokerConnectionState,
  BrokerFill,
  BrokerOrderRequest,
  BrokerOrderStatus,
  ExecutionOutcome,
  OrderStatus,
  OrderUpdate,
} from "@neelkanth/core";
import type { Broker } from "./broker.js";

export interface ScriptedFakeBrokerOptions {
  /** Fill price for auto-filled (unscripted) orders. */
  defaultFillPrice?: number;
  defaultSlippage?: number;
  defaultCharges?: number;
  /** When true, unscripted orders return PENDING instead of auto-FILLED. */
  pendingByDefault?: boolean;
}

/**
 * A scripted, in-memory `Broker` test double (plan/27 §6: "a scripted fake
 * broker for order-path tests" — dependency injection paying its testing
 * dividend, plan/05 §3). Deterministic and side-effect free: it records what
 * it was asked to do and lets a test drive async updates, data, and
 * connection changes by hand.
 *
 * Honesty rule (plan/11 §9): it never invents a fill price. An unscripted
 * order with no `defaultFillPrice` throws rather than fabricating one.
 */
export class ScriptedFakeBroker implements Broker {
  readonly submitted: BrokerOrderRequest[] = [];
  readonly cancelled: string[] = [];
  readonly subscriptions = new Set<string>();
  connectionState: BrokerConnectionState = "disconnected";

  private readonly options: ScriptedFakeBrokerOptions;
  private readonly scripted = new Map<string, ExecutionOutcome>();
  private readonly known = new Map<
    string,
    { status: OrderStatus; brokerOrderId?: string }
  >();
  private readonly orderUpdateHandlers: ((u: OrderUpdate) => void)[] = [];
  private readonly dataHandlers: ((raw: unknown) => void)[] = [];
  private readonly connectionHandlers: ((s: BrokerConnectionState) => void)[] =
    [];
  private seq = 0;

  constructor(options: ScriptedFakeBrokerOptions = {}) {
    this.options = options;
  }

  // --- Test-facing scripting API ---

  /** Predetermine the exact outcome `execute` returns for one order. */
  scriptExecution(clientOrderId: string, outcome: ExecutionOutcome): void {
    this.scripted.set(clientOrderId, outcome);
  }

  /** Fire an async order update (a later fill/rejection/cancel of a pending). */
  emitOrderUpdate(update: OrderUpdate): void {
    this.recordUpdate(update);
    for (const handler of this.orderUpdateHandlers) handler(update);
  }

  /** Deliver a raw market-data message to the Market Data Engine callback. */
  emitData(raw: unknown): void {
    for (const handler of this.dataHandlers) handler(raw);
  }

  /** Drive a connection-state transition (fires onConnectionChange). */
  setConnectionState(state: BrokerConnectionState): void {
    this.connectionState = state;
    for (const handler of this.connectionHandlers) handler(state);
  }

  // --- Broker: execution ---

  execute(order: BrokerOrderRequest): Promise<ExecutionOutcome> {
    this.submitted.push(order);
    let outcome: ExecutionOutcome;
    try {
      outcome = this.scripted.get(order.clientOrderId) ?? this.auto(order);
    } catch (error) {
      // Surface as a rejected promise, not a sync throw — callers `await`
      // execute and expect a Promise contract (plan/19 §2).
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    this.recordOutcome(order.clientOrderId, outcome);
    return Promise.resolve(outcome);
  }

  cancel(clientOrderId: string): Promise<void> {
    this.cancelled.push(clientOrderId);
    this.known.set(clientOrderId, { status: "CANCELLED" });
    return Promise.resolve();
  }

  status(clientOrderId: string): Promise<BrokerOrderStatus> {
    const known = this.known.get(clientOrderId);
    if (!known) {
      return Promise.resolve({ clientOrderId, found: false });
    }
    return Promise.resolve({
      clientOrderId,
      found: true,
      status: known.status,
      ...(known.brokerOrderId === undefined
        ? {}
        : { brokerOrderId: known.brokerOrderId }),
    });
  }

  onOrderUpdate(handler: (update: OrderUpdate) => void): void {
    this.orderUpdateHandlers.push(handler);
  }

  // --- Broker: market data ---

  connect(): Promise<void> {
    this.setConnectionState("connected");
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.setConnectionState("disconnected");
    return Promise.resolve();
  }

  subscribe(symbols: readonly string[]): Promise<void> {
    for (const symbol of symbols) this.subscriptions.add(symbol);
    return Promise.resolve();
  }

  onData(handler: (raw: unknown) => void): void {
    this.dataHandlers.push(handler);
  }

  onConnectionChange(handler: (state: BrokerConnectionState) => void): void {
    this.connectionHandlers.push(handler);
  }

  // --- Internals ---

  private auto(order: BrokerOrderRequest): ExecutionOutcome {
    if (this.options.pendingByDefault) {
      return {
        status: "PENDING",
        clientOrderId: order.clientOrderId,
        brokerOrderId: this.nextBrokerId(),
      };
    }
    if (this.options.defaultFillPrice === undefined) {
      throw new Error(
        `ScriptedFakeBroker: order ${order.clientOrderId} is unscripted and no ` +
          `defaultFillPrice was set — refusing to fabricate a fill price (plan/11 §9)`,
      );
    }
    const fill: BrokerFill = {
      clientOrderId: order.clientOrderId,
      brokerOrderId: this.nextBrokerId(),
      filledPrice: this.options.defaultFillPrice,
      filledQty: order.qty,
      slippage: this.options.defaultSlippage ?? 0,
      charges: this.options.defaultCharges ?? 0,
      filledAt: Date.now(),
    };
    return { status: "FILLED", fill };
  }

  private recordOutcome(
    clientOrderId: string,
    outcome: ExecutionOutcome,
  ): void {
    if (outcome.status === "FILLED") {
      this.known.set(clientOrderId, {
        status: "FILLED",
        ...(outcome.fill.brokerOrderId === undefined
          ? {}
          : { brokerOrderId: outcome.fill.brokerOrderId }),
      });
    } else if (outcome.status === "PENDING") {
      this.known.set(clientOrderId, {
        status: "PENDING",
        brokerOrderId: outcome.brokerOrderId,
      });
    } else {
      this.known.set(clientOrderId, { status: "REJECTED" });
    }
  }

  private recordUpdate(update: OrderUpdate): void {
    if (update.status === "FILLED") {
      this.known.set(update.fill.clientOrderId, {
        status: "FILLED",
        ...(update.fill.brokerOrderId === undefined
          ? {}
          : { brokerOrderId: update.fill.brokerOrderId }),
      });
    } else {
      this.known.set(update.clientOrderId, { status: update.status });
    }
  }

  private nextBrokerId(): string {
    this.seq += 1;
    return `fake-broker-${String(this.seq)}`;
  }
}
