import type {
  BrokerOrderRequest,
  ExecutionOutcome,
  Order,
  OrderSide,
  RiskDecision,
  Signal,
} from "@neelkanth/core";
import type { Broker } from "@neelkanth/broker";
import type { OrderPorts } from "./ports.js";

/** The execution slice of the Broker the Order Manager uses (plan/19 §2). */
export type ExecutionBroker = Pick<Broker, "execute" | "cancel" | "status">;

export type OrderResult =
  | { status: "filled"; order: Order }
  | { status: "rejected"; order: Order; reason: string }
  | { status: "pending"; order: Order }
  | { status: "halted"; reason: string }
  | { status: "duplicate"; signalId: string }
  | { status: "unknown"; orderId: string };

export interface OrderManagerDeps {
  broker: ExecutionBroker;
  ports: OrderPorts;
  nextOrderId: () => string;
  now?: () => number;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The Order Manager (plan/12): the single choke point every order passes
 * through. It turns a risk-approved signal into a broker order, submits it,
 * owns the order's lifecycle and persistence, and emits the events that start
 * the projection chain.
 *
 * Because there is exactly one road to the broker: one switch stops everything
 * (the kill gate), one audit stream (`orders`), one place broker edge-cases are
 * handled (plan/12 §2). Called synchronously with a risk-approved signal
 * (Regime A) and emits asynchronously afterward (Regime B) — this is where
 * Regime A ends and Regime B begins (plan/12 §3).
 */
export class OrderManager {
  private readonly broker: ExecutionBroker;
  private readonly ports: OrderPorts;
  private readonly nextOrderId: () => string;
  private readonly now: () => number;
  private readonly onError: OrderManagerDeps["onError"];
  /** Halts new submissions on BROKER_DISCONNECTED (plan/12 §7). */
  private brokerConnected = true;

  constructor(deps: OrderManagerDeps) {
    this.broker = deps.broker;
    this.ports = deps.ports;
    this.nextOrderId = deps.nextOrderId;
    this.now = deps.now ?? (() => Date.now());
    this.onError = deps.onError;
  }

  /** BROKER_CONNECTED / BROKER_DISCONNECTED toggle (plan/12 §7). */
  setBrokerConnected(connected: boolean): void {
    this.brokerConnected = connected;
  }

  /**
   * Place a risk-approved signal (plan/12 §4). Kill gate → construct →
   * persist-first → emit ORDER_PLACED → submit → record outcome. Never blind-
   * retries an unknown outcome (plan/12 §8).
   */
  async place(signal: Signal, decision: RiskDecision): Promise<OrderResult> {
    try {
      // 1. The kill gate — absolute, one flag, before anything (plan/12 §4.1).
      if (!(await this.ports.readTradingEnabled())) {
        return { status: "halted", reason: "trading disabled (pause/kill)" };
      }
      // Halt on broker disconnect — never fire against an unconfirmable broker.
      if (!this.brokerConnected) {
        return { status: "halted", reason: "broker disconnected" };
      }
      if (signal.side === "HOLD") {
        return { status: "halted", reason: "HOLD never reaches the broker" };
      }
      const side: OrderSide = signal.side;
      const qty =
        decision.decision === "approved" && decision.cappedQty !== undefined
          ? decision.cappedQty
          : signal.qtyProposal;
      if (qty === undefined) {
        return { status: "halted", reason: "no quantity to place" };
      }

      // 2. Construct the order (signals are decisions; orders are instructions).
      const order: Order = {
        orderId: this.nextOrderId(),
        signalId: signal.signalId,
        strategyId: signal.strategyId,
        symbol: signal.symbol,
        side,
        qty,
        type: "MARKET",
        status: "PLACED",
        mode: "paper",
        createdAt: this.now(),
      };

      // 3. Persist FIRST, then submit (plan/12 §4.3): a durable "may exist at
      //    broker" record is what makes crash recovery possible. The unique
      //    signalId index is the duplicate backstop (plan/12 §6).
      const inserted = await this.ports.persistOrder(order);
      if (!inserted) {
        return { status: "duplicate", signalId: signal.signalId };
      }
      await this.ports.publish(
        "ORDER_PLACED",
        {
          orderId: order.orderId,
          signalId: order.signalId,
          strategyId: order.strategyId,
          symbol: order.symbol,
          side: order.side,
          qty: order.qty,
          type: order.type,
          mode: order.mode,
          ts: order.createdAt,
        },
        signal.signalId,
      );

      // 4. Submit via the Broker interface (Paper now, FYERS in Phase 3).
      let outcome: ExecutionOutcome;
      try {
        outcome = await this.broker.execute(toBrokerRequest(order));
      } catch (error) {
        // The dangerous case (plan/12 §8): the outcome is unknown. NEVER blind-
        // retry — a retry risks double execution. Leave the durable PLACED
        // record for reconcile-then-decide on recovery.
        this.onError(error, {
          where: "broker.execute",
          orderId: order.orderId,
        });
        return { status: "unknown", orderId: order.orderId };
      }

      // 5. Record the outcome.
      return await this.recordOutcome(order, outcome);
    } catch (error) {
      this.onError(error, { where: "place", signalId: signal.signalId });
      return { status: "halted", reason: "order placement failed" };
    }
  }

  /** Reconcile a stuck PLACED/PENDING order against the broker (plan/12 §8). */
  async reconcile(order: Order): Promise<OrderResult> {
    const status = await this.broker.status(order.orderId);
    if (!status.found) {
      // Verifiably absent at the broker — safe to leave for resubmit decision.
      return { status: "unknown", orderId: order.orderId };
    }
    if (status.status === "FILLED") {
      await this.ports.updateOrder(order.orderId, { status: "FILLED" });
      return { status: "filled", order: { ...order, status: "FILLED" } };
    }
    if (status.status === "REJECTED" || status.status === "CANCELLED") {
      await this.ports.updateOrder(order.orderId, { status: status.status });
      return status.status === "REJECTED"
        ? { status: "rejected", order, reason: "reconciled: rejected" }
        : { status: "halted", reason: "reconciled: cancelled" };
    }
    return { status: "pending", order };
  }

  private async recordOutcome(
    order: Order,
    outcome: ExecutionOutcome,
  ): Promise<OrderResult> {
    if (outcome.status === "FILLED") {
      const { fill } = outcome;
      const patch: Partial<Order> = {
        status: "FILLED",
        filledPrice: fill.filledPrice,
        slippage: fill.slippage,
        charges: fill.charges,
        filledAt: fill.filledAt,
        ...(fill.brokerOrderId === undefined
          ? {}
          : { brokerOrderId: fill.brokerOrderId }),
      };
      await this.ports.updateOrder(order.orderId, patch);
      await this.ports.publish(
        "ORDER_FILLED",
        {
          orderId: order.orderId,
          strategyId: order.strategyId,
          symbol: order.symbol,
          side: order.side,
          qty: order.qty,
          filledPrice: fill.filledPrice,
          slippage: fill.slippage,
          charges: fill.charges,
          filledAt: fill.filledAt,
          mode: order.mode,
          ts: fill.filledAt,
        },
        order.signalId,
      );
      return { status: "filled", order: { ...order, ...patch } };
    }

    if (outcome.status === "REJECTED") {
      await this.ports.updateOrder(order.orderId, { status: "REJECTED" });
      return {
        status: "rejected",
        order: { ...order, status: "REJECTED" },
        reason: outcome.reason,
      };
    }

    // PENDING (limit awaiting price).
    await this.ports.updateOrder(order.orderId, {
      status: "PENDING",
      brokerOrderId: outcome.brokerOrderId,
    });
    return { status: "pending", order: { ...order, status: "PENDING" } };
  }
}

function toBrokerRequest(order: Order): BrokerOrderRequest {
  // The client order reference is always our orderId (plan/19 §5).
  return {
    clientOrderId: order.orderId,
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    type: order.type,
    ...(order.price === undefined ? {} : { price: order.price }),
  };
}
