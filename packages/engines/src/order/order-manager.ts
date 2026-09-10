import type {
  BrokerOrderRequest,
  TradeMode,
  ExecutionOutcome,
  Order,
  OrderSide,
  OrderUpdate,
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
  /**
   * Whether these orders are simulated or real, stamped onto every persisted
   * order and every ORDER_FILLED event.
   *
   * INJECTED, never inferred from which broker was wired. It was hardcoded
   * "paper", so a live FYERS execution persisted a row saying "paper" — the
   * audit trail contradicting the money that actually moved. Reading it off
   * the broker implementation would be almost as bad: the composition root
   * can wrap a live data feed around paper execution, so the object identity
   * does not answer the question. BROKER_MODE does.
   */
  mode: TradeMode;
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
  private readonly mode: TradeMode;
  private readonly nextOrderId: () => string;
  private readonly now: () => number;
  private readonly onError: OrderManagerDeps["onError"];
  /** Halts new submissions on BROKER_DISCONNECTED (plan/12 §7). */
  private brokerConnected = true;

  constructor(deps: OrderManagerDeps) {
    this.broker = deps.broker;
    this.ports = deps.ports;
    this.mode = deps.mode;
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
        ...(signal.stopLoss !== undefined ? { stopLoss: signal.stopLoss } : {}),
        ...(signal.target !== undefined ? { takeProfit: signal.target } : {}),
        status: "PLACED",
        mode: this.mode,
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
      //    The decision-time price rides along so a MARKET order's protective
      //    legs can be expressed as offsets — see `referencePrice`.
      let outcome: ExecutionOutcome;
      try {
        outcome = await this.broker.execute(
          toBrokerRequest(order, signal.contextSnapshot.price),
        );
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

  /**
   * Apply an asynchronous order update from the broker (plan/19 §5).
   *
   * This is the other half of a live submission. `execute()` returns PENDING —
   * the exchange has accepted the order, nothing has traded yet — and the fill
   * arrives later on the broker's own stream. Without this handler that stream
   * had no destination: `onOrderUpdate` collected handlers that nothing ever
   * invoked, so a live order stayed PENDING forever. No ORDER_FILLED, no
   * position, no PnL, while the money had actually moved.
   *
   * IDEMPOTENT (plan/09 §5): the socket reconnects and replays, and the same
   * fill can also arrive via `reconcile()`. An order already in a terminal
   * state is left alone rather than projected twice — a double ORDER_FILLED
   * would double the position.
   *
   * Never rejects; failures route to `onError`, because this runs on a socket
   * callback with no caller to catch anything.
   */
  async onBrokerUpdate(update: OrderUpdate): Promise<void> {
    try {
      const orderId =
        update.status === "FILLED"
          ? update.fill.clientOrderId
          : update.clientOrderId;
      const order = await this.ports.readOrder(orderId);
      if (order === null) {
        // Not ours, or never persisted. Surfaced rather than dropped: an
        // update for an unknown order means our audit trail has a hole.
        this.onError(new Error("order update for an unknown order"), {
          where: "onBrokerUpdate",
          orderId,
          status: update.status,
        });
        return;
      }
      if (order.status !== "PLACED" && order.status !== "PENDING") {
        return; // already terminal — a replay, not news
      }

      if (update.status === "FILLED") {
        const { fill } = update;
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
        // The same event, same shape, as the synchronous fill path — one fill
        // projection, not two that can drift (plan/02 §6).
        await this.ports.publish(
          "ORDER_FILLED",
          {
            orderId: order.orderId,
            strategyId: order.strategyId,
            symbol: order.symbol,
            side: order.side,
            qty: fill.filledQty,
            filledPrice: fill.filledPrice,
            slippage: fill.slippage,
            charges: fill.charges,
            ...OrderManager.protective(order),
            filledAt: fill.filledAt,
            mode: order.mode,
            ts: fill.filledAt,
          },
          order.signalId,
        );
        return;
      }

      if (update.status === "REJECTED") {
        const patch: Partial<Order> = {
          status: "REJECTED",
          rejectReason: update.reason,
          ...(update.code === undefined ? {} : { rejectCode: update.code }),
        };
        await this.ports.updateOrder(order.orderId, patch);
        await this.ports.publish(
          "ORDER_REJECTED",
          {
            orderId: order.orderId,
            signalId: order.signalId,
            strategyId: order.strategyId,
            symbol: order.symbol,
            side: order.side,
            qty: order.qty,
            reason: update.reason,
            ...(update.code === undefined ? {} : { code: update.code }),
            mode: order.mode,
            ts: this.now(),
          },
          order.signalId,
        );
        return;
      }

      // CANCELLED: terminal, but nothing traded — no projection to publish.
      await this.ports.updateOrder(order.orderId, { status: "CANCELLED" });
    } catch (error) {
      this.onError(error, { where: "onBrokerUpdate" });
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
      // The order filled while we were away. Marking the row FILLED is only
      // half the job: the normal path also publishes ORDER_FILLED, which is
      // what drives Position → PnL. Persisting without publishing leaves our
      // books silently disagreeing with the broker — we hold a position we do
      // not know about (plan/02 §6, the projection chain).
      //
      // The fill must be reconstructed FAITHFULLY or not at all. Without a
      // price from the broker, a published fill would invent an average entry
      // and every P&L figure downstream would be wrong — worse than a gap we
      // can see. So a price-less FILLED is escalated, not approximated.
      if (status.filledPrice === undefined) {
        await this.ports.publish(
          "SYSTEM_ERROR",
          {
            source: "orderManager.reconcile",
            level: "error",
            message:
              "broker reports FILLED but returned no fill price — position " +
              "and PnL cannot be reconciled automatically; operator must " +
              "verify against the broker's contract note",
            context: { orderId: order.orderId, symbol: order.symbol },
            ts: Date.now(),
          },
          order.signalId,
        );
        return { status: "unknown", orderId: order.orderId };
      }

      const filledAt = status.filledAt ?? Date.now();
      const filledQty = status.filledQty ?? order.qty;
      const patch: Partial<Order> = {
        status: "FILLED",
        filledPrice: status.filledPrice,
        filledAt,
        ...(status.brokerOrderId === undefined
          ? {}
          : { brokerOrderId: status.brokerOrderId }),
      };
      await this.ports.updateOrder(order.orderId, patch);
      // Deliberately the same event, with the same shape, as the live path —
      // one fill projection, not two that can drift (plan/02 §6). Slippage and
      // charges are 0: they are not knowable from a status query, and a
      // fabricated cost would be a second lie on top of the first.
      await this.ports.publish(
        "ORDER_FILLED",
        {
          orderId: order.orderId,
          strategyId: order.strategyId,
          symbol: order.symbol,
          side: order.side,
          qty: filledQty,
          filledPrice: status.filledPrice,
          slippage: 0,
          charges: 0,
          ...OrderManager.protective(order),
          filledAt,
          mode: order.mode,
          ts: filledAt,
        },
        order.signalId,
      );
      return { status: "filled", order: { ...order, ...patch } };
    }
    if (status.status === "REJECTED" || status.status === "CANCELLED") {
      await this.ports.updateOrder(order.orderId, { status: status.status });
      return status.status === "REJECTED"
        ? { status: "rejected", order, reason: "reconciled: rejected" }
        : { status: "halted", reason: "reconciled: cancelled" };
    }
    return { status: "pending", order };
  }

  /**
   * The protective levels to forward on ORDER_FILLED. Shared by all three fill
   * paths (synchronous, broker stream, reconcile) so a stop can never depend on
   * which route the fill happened to arrive by.
   */
  private static protective(
    order: Order,
  ): Partial<Pick<Order, "stopLoss" | "takeProfit">> {
    return {
      ...(order.stopLoss === undefined ? {} : { stopLoss: order.stopLoss }),
      ...(order.takeProfit === undefined
        ? {}
        : { takeProfit: order.takeProfit }),
    };
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
          ...OrderManager.protective(order),
          filledAt: fill.filledAt,
          mode: order.mode,
          ts: fill.filledAt,
        },
        order.signalId,
      );
      return { status: "filled", order: { ...order, ...patch } };
    }

    if (outcome.status === "REJECTED") {
      // Persist AND publish the broker's reason. It used to be returned to the
      // caller and dropped: `status: REJECTED` with no explanation in the row,
      // no event, and nothing in the logs — the one fact that explains the
      // failure, discarded at the moment it arrived. For an F&O order refused
      // over lot size, margin or product type, that reason IS the diagnosis.
      const patch: Partial<Order> = {
        status: "REJECTED",
        rejectReason: outcome.reason,
        ...(outcome.code === undefined ? {} : { rejectCode: outcome.code }),
      };
      await this.ports.updateOrder(order.orderId, patch);
      await this.ports.publish(
        "ORDER_REJECTED",
        {
          orderId: order.orderId,
          signalId: order.signalId,
          strategyId: order.strategyId,
          symbol: order.symbol,
          side: order.side,
          qty: order.qty,
          reason: outcome.reason,
          ...(outcome.code === undefined ? {} : { code: outcome.code }),
          mode: order.mode,
          ts: this.now(),
        },
        order.signalId,
      );
      return {
        status: "rejected",
        order: { ...order, ...patch },
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

function toBrokerRequest(
  order: Order,
  referencePrice?: number,
): BrokerOrderRequest {
  // The client order reference is always our orderId (plan/19 §5).
  // `referencePrice` prefers the order's own limit when it has one: that IS
  // the entry the protective legs hang off. It falls back to the decision
  // price, which is the only entry estimate a MARKET order has.
  const reference = order.price ?? referencePrice;
  return {
    clientOrderId: order.orderId,
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    type: order.type,
    ...(order.price === undefined ? {} : { price: order.price }),
    ...(order.stopLoss === undefined ? {} : { stopLoss: order.stopLoss }),
    ...(order.takeProfit === undefined ? {} : { takeProfit: order.takeProfit }),
    ...(reference === undefined ? {} : { referencePrice: reference }),
  };
}
