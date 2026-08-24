import { describe, expect, it, vi } from "vitest";
import type {
  BrokerOrderStatus,
  Order,
  RiskDecision,
  Signal,
} from "@neelkanth/core";
import type { EventName } from "@neelkanth/contracts";
import { ScriptedFakeBroker } from "@neelkanth/broker";
import { OrderManager, type ExecutionBroker } from "./order-manager.js";
import type { OrderPorts } from "./ports.js";

function harness(
  opts: {
    broker?: ExecutionBroker;
    tradingEnabled?: boolean;
    persistReturns?: boolean;
    mode?: "paper" | "live";
  } = {},
) {
  const orders = new Map<string, Order>();
  const events: { name: EventName; payload: unknown }[] = [];
  const errors: { error: unknown; context: Record<string, unknown> }[] = [];
  const persistReturns = opts.persistReturns ?? true;

  const ports: OrderPorts = {
    readTradingEnabled: () => Promise.resolve(opts.tradingEnabled ?? true),
    persistOrder: (order) => {
      if (!persistReturns) return Promise.resolve(false); // duplicate signalId
      orders.set(order.orderId, order);
      return Promise.resolve(true);
    },
    updateOrder: (orderId, patch) => {
      const existing = orders.get(orderId);
      if (existing) orders.set(orderId, { ...existing, ...patch });
      return Promise.resolve();
    },
    readOrder: (orderId) => Promise.resolve(orders.get(orderId) ?? null),
    publish: (name, payload) => {
      events.push({ name, payload });
      return Promise.resolve();
    },
  };

  const broker =
    opts.broker ?? new ScriptedFakeBroker({ defaultFillPrice: 100 });
  let idSeq = 0;
  const manager = new OrderManager({
    broker,
    ports,
    mode: opts.mode ?? "paper",
    nextOrderId: () => {
      idSeq += 1;
      return `ord_${String(idSeq)}`;
    },
    now: () => 1000,
    onError: (error, context) => errors.push({ error, context }),
  });
  return { manager, orders, events, errors, broker };
}

const approved: RiskDecision = { decision: "approved" };

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    signalId: "sig_1",
    strategyId: "str_1",
    symbol: "NSE:RELIANCE-EQ",
    side: "BUY",
    confidence: 1,
    qtyProposal: 10,
    reason: "test",
    contextSnapshot: {
      price: 100,
      indicators: {},
      session: "open",
      sentiment: 0,
    },
    ts: 1000,
    ...overrides,
  };
}

describe("OrderManager happy path (plan/12 §4)", () => {
  it("persists PLACED, emits ORDER_PLACED, fills, and emits ORDER_FILLED", async () => {
    const h = harness();
    const result = await h.manager.place(signal(), approved);

    expect(result.status).toBe("filled");
    const order = h.orders.get("ord_1");
    expect(order?.status).toBe("FILLED");
    expect(order?.filledPrice).toBe(100);
    const names = h.events.map((e) => e.name);
    expect(names).toEqual(["ORDER_PLACED", "ORDER_FILLED"]);
  });

  it("uses the risk-capped quantity, not the proposal (plan/14 §4.4)", async () => {
    const h = harness();
    await h.manager.place(signal({ qtyProposal: 100 }), {
      decision: "approved",
      cappedQty: 30,
    });
    expect(h.orders.get("ord_1")?.qty).toBe(30);
  });
});

describe("OrderManager the kill gate (plan/12 §4.1)", () => {
  it("refuses all orders when trading is disabled — no persist, no execute", async () => {
    const h = harness({ tradingEnabled: false });
    const result = await h.manager.place(signal(), approved);
    expect(result).toEqual({
      status: "halted",
      reason: "trading disabled (pause/kill)",
    });
    expect(h.orders.size).toBe(0);
    expect(h.events).toHaveLength(0);
  });

  it("halts new submissions while the broker is disconnected (plan/12 §7)", async () => {
    const h = harness();
    h.manager.setBrokerConnected(false);
    expect((await h.manager.place(signal(), approved)).status).toBe("halted");
    h.manager.setBrokerConnected(true);
    expect((await h.manager.place(signal(), approved)).status).toBe("filled");
  });
});

describe("OrderManager the signalId backstop (plan/12 §6)", () => {
  it("returns duplicate and does not execute when the unique index rejects", async () => {
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 100 });
    const h = harness({ broker, persistReturns: false });
    const result = await h.manager.place(signal(), approved);
    expect(result).toEqual({ status: "duplicate", signalId: "sig_1" });
    expect(h.events).toHaveLength(0); // never emitted ORDER_PLACED
    expect(broker.submitted).toHaveLength(0); // never executed
  });
});

describe("OrderManager broker outcomes (plan/12 §4.5, §8)", () => {
  it("records a broker rejection as REJECTED", async () => {
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 100 });
    broker.scriptExecution("ord_1", {
      status: "REJECTED",
      clientOrderId: "ord_1",
      reason: "margin insufficient",
    });
    const h = harness({ broker });
    const result = await h.manager.place(signal(), approved);
    expect(result).toMatchObject({ status: "rejected" });
    expect(h.orders.get("ord_1")?.status).toBe("REJECTED");
  });

  it("holds a PENDING outcome without a fill event", async () => {
    const broker = new ScriptedFakeBroker({ pendingByDefault: true });
    const h = harness({ broker });
    const result = await h.manager.place(signal(), approved);
    expect(result.status).toBe("pending");
    expect(h.orders.get("ord_1")?.status).toBe("PENDING");
    expect(h.events.some((e) => e.name === "ORDER_FILLED")).toBe(false);
  });

  it("NEVER blind-retries an unknown outcome; leaves the PLACED record (plan/12 §8)", async () => {
    const broker: ExecutionBroker = {
      execute: () => Promise.reject(new Error("submission timed out")),
      cancel: () => Promise.resolve(),
      status: () => Promise.resolve({ clientOrderId: "ord_1", found: false }),
    };
    const h = harness({ broker });
    const result = await h.manager.place(signal(), approved);
    expect(result).toEqual({ status: "unknown", orderId: "ord_1" });
    // The durable PLACED record survives for reconcile-then-decide.
    expect(h.orders.get("ord_1")?.status).toBe("PLACED");
    expect(h.errors).toHaveLength(1);
  });
});

describe("OrderManager reconciliation (plan/12 §8)", () => {
  it("reconciles a stuck PLACED order that the broker reports FILLED", async () => {
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 100 });
    await broker.execute({
      clientOrderId: "ord_9",
      symbol: "NSE:X-EQ",
      side: "BUY",
      qty: 5,
      type: "MARKET",
    }); // broker now knows ord_9 as FILLED
    const h = harness({ broker });
    const stuck: Order = {
      orderId: "ord_9",
      signalId: "sig_9",
      strategyId: "str_1",
      symbol: "NSE:X-EQ",
      side: "BUY",
      qty: 5,
      type: "MARKET",
      status: "PLACED",
      mode: "paper",
      createdAt: 1000,
    };
    h.orders.set("ord_9", stuck);
    const result = await h.manager.reconcile(stuck);
    expect(result.status).toBe("filled");
    expect(h.orders.get("ord_9")?.status).toBe("FILLED");
  });

  it("reports unknown for an order the broker has never seen", async () => {
    const h = harness();
    const stuck: Order = {
      orderId: "ord_x",
      signalId: "sig_x",
      strategyId: "str_1",
      symbol: "NSE:X-EQ",
      side: "BUY",
      qty: 5,
      type: "MARKET",
      status: "PLACED",
      mode: "paper",
      createdAt: 1000,
    };
    expect((await h.manager.reconcile(stuck)).status).toBe("unknown");
  });
});

describe("reconcile completes the projection chain (crash recovery)", () => {
  /** A PLACED order the broker later reports on, as after a crash. */
  const stuck: Order = {
    orderId: "ord_stuck",
    signalId: "sig_stuck",
    strategyId: "str_1",
    symbol: "NSE:RELIANCE-EQ",
    side: "BUY",
    qty: 10,
    type: "MARKET",
    status: "PLACED",
    mode: "paper",
    createdAt: 1000,
  };

  function brokerReporting(
    status: Partial<BrokerOrderStatus>,
  ): ExecutionBroker {
    return {
      execute: () =>
        Promise.resolve({
          status: "REJECTED" as const,
          clientOrderId: stuck.orderId,
          reason: "unused by reconcile",
        }),
      cancel: () => Promise.resolve(),
      status: () =>
        Promise.resolve({
          clientOrderId: stuck.orderId,
          found: true,
          ...status,
        }),
    };
  }

  it("publishes ORDER_FILLED, not just a status update", async () => {
    // Persisting FILLED without publishing closes the order row but leaves
    // the Position and PnL engines ignorant: the books silently disagree with
    // the broker, and we hold a position we do not know about.
    const { manager, events } = harness({
      broker: brokerReporting({
        status: "FILLED",
        filledPrice: 101.5,
        filledQty: 10,
        filledAt: 1_700_000_000_000,
      }),
    });

    const result = await manager.reconcile(stuck);

    expect(result.status).toBe("filled");
    const filled = events.filter((e) => e.name === "ORDER_FILLED");
    expect(filled).toHaveLength(1);
    expect(filled[0]?.payload).toMatchObject({
      orderId: "ord_stuck",
      filledPrice: 101.5,
      qty: 10,
    });
  });

  it("refuses to invent a fill price when the broker reports none", async () => {
    // A guessed price corrupts the position's average entry and every P&L
    // figure derived from it — worse than a gap the operator can see.
    const { manager, events } = harness({
      broker: brokerReporting({ status: "FILLED" }),
    });

    const result = await manager.reconcile(stuck);

    expect(result.status).toBe("unknown");
    expect(events.filter((e) => e.name === "ORDER_FILLED")).toEqual([]);
    expect(events.filter((e) => e.name === "SYSTEM_ERROR")).toHaveLength(1);
  });
});

describe("order mode is injected, not assumed", () => {
  it.each(["live", "paper"] as const)("stamps a %s order correctly", async (mode) => {
    // Hardcoded "paper" meant a live FYERS execution persisted a row saying
    // "paper" — the audit trail contradicting the money that actually moved.
    const { manager, orders } = harness({ mode });
    await manager.place(signal(), approved);
    expect([...orders.values()][0]?.mode).toBe(mode);
  });
});

describe("a rejection explains itself (plan/12 §5)", () => {
  function rejectingBroker(reason: string, code?: string): ExecutionBroker {
    return {
      execute: (o) =>
        Promise.resolve({
          status: "REJECTED" as const,
          clientOrderId: o.clientOrderId,
          reason,
          ...(code === undefined ? {} : { code }),
        }),
      cancel: () => Promise.resolve(),
      status: (id) => Promise.resolve({ clientOrderId: id, found: false }),
    };
  }

  /** The real thing an F&O rejection looks like. */
  const LOT = "quantity should be in multiples of lot size 65";

  it("persists the broker's reason on the order row", async () => {
    // It used to be returned to the caller and dropped, leaving a REJECTED row
    // with no explanation anywhere — database, events, or logs.
    const { manager, orders } = harness({ broker: rejectingBroker(LOT, "-99") });
    await manager.place(signal(), approved);

    const stored = [...orders.values()][0];
    expect(stored?.status).toBe("REJECTED");
    expect(stored?.rejectReason).toBe(LOT);
    expect(stored?.rejectCode).toBe("-99");
  });

  it("publishes ORDER_REJECTED so the dashboard can show why", async () => {
    const { manager, events } = harness({ broker: rejectingBroker(LOT) });
    await manager.place(signal(), approved);

    const rejected = events.filter((e) => e.name === "ORDER_REJECTED");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({
      symbol: "NSE:RELIANCE-EQ",
      reason: LOT,
    });
  });

  it("omits the code when the broker gave none, rather than inventing one", async () => {
    const { manager, orders } = harness({ broker: rejectingBroker(LOT) });
    await manager.place(signal(), approved);
    expect([...orders.values()][0]?.rejectCode).toBeUndefined();
  });

  it("still reports the reason to the caller", async () => {
    const { manager } = harness({ broker: rejectingBroker(LOT) });
    const result = await manager.place(signal(), approved);
    expect(result).toMatchObject({ status: "rejected", reason: LOT });
  });
});

describe("async broker updates finish a live order (plan/19 §5)", () => {
  /** A live broker: accepts, returns PENDING, fills later on its stream. */
  function pendingHarness() {
    const broker = new ScriptedFakeBroker({ pendingByDefault: true });
    const h = harness({ broker, mode: "live" });
    broker.onOrderUpdate((u) => {
      void h.manager.onBrokerUpdate(u);
    });
    return { ...h, broker };
  }

  it("leaves the order PENDING at submission, then FILLS it on the update", async () => {
    // The gap this closes: execute() returns PENDING and the fill only ever
    // arrives on the order stream. Nothing consumed that stream, so a live
    // order stayed PENDING forever — no ORDER_FILLED, no position, no PnL.
    const h = pendingHarness();
    const result = await h.manager.place(signal(), approved);
    expect(result.status).toBe("pending");
    expect(h.orders.get("ord_1")?.status).toBe("PENDING");

    h.broker.emitOrderUpdate({
      status: "FILLED",
      fill: {
        clientOrderId: "ord_1",
        brokerOrderId: "fy-77",
        filledPrice: 101.5,
        filledQty: 10,
        slippage: 0,
        charges: 0,
        filledAt: 2000,
      },
    });
    await vi.waitFor(() => {
      expect(h.orders.get("ord_1")?.status).toBe("FILLED");
    });

    const stored = h.orders.get("ord_1");
    expect(stored?.filledPrice).toBe(101.5);
    expect(stored?.brokerOrderId).toBe("fy-77");
    expect(h.events.map((e) => e.name)).toEqual([
      "ORDER_PLACED",
      "ORDER_FILLED",
    ]);
  });

  it("publishes ORDER_FILLED with the live mode and the order's attribution", async () => {
    const h = pendingHarness();
    await h.manager.place(signal(), approved);
    h.broker.emitOrderUpdate({
      status: "FILLED",
      fill: {
        clientOrderId: "ord_1",
        filledPrice: 101.5,
        filledQty: 10,
        slippage: 0,
        charges: 0,
        filledAt: 2000,
      },
    });
    await vi.waitFor(() => {
      expect(h.events).toHaveLength(2);
    });

    expect(h.events[1]?.payload).toMatchObject({
      orderId: "ord_1",
      strategyId: "str_1",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 10,
      filledPrice: 101.5,
      mode: "live",
    });
  });

  it("is idempotent — a replayed fill does not project the position twice", async () => {
    // The socket reconnects and replays, and reconcile() can deliver the same
    // fill. A second ORDER_FILLED would double the position.
    const h = pendingHarness();
    await h.manager.place(signal(), approved);
    const fill = {
      status: "FILLED" as const,
      fill: {
        clientOrderId: "ord_1",
        filledPrice: 101.5,
        filledQty: 10,
        slippage: 0,
        charges: 0,
        filledAt: 2000,
      },
    };
    await h.manager.onBrokerUpdate(fill);
    await h.manager.onBrokerUpdate(fill);

    expect(h.events.filter((e) => e.name === "ORDER_FILLED")).toHaveLength(1);
  });

  it("records a late rejection with its reason", async () => {
    const h = pendingHarness();
    await h.manager.place(signal(), approved);
    await h.manager.onBrokerUpdate({
      status: "REJECTED",
      clientOrderId: "ord_1",
      reason: "insufficient margin",
      code: "-390",
    });

    const stored = h.orders.get("ord_1");
    expect(stored?.status).toBe("REJECTED");
    expect(stored?.rejectReason).toBe("insufficient margin");
    expect(stored?.rejectCode).toBe("-390");
    expect(h.events.filter((e) => e.name === "ORDER_REJECTED")).toHaveLength(1);
  });

  it("records a cancellation without publishing a fill", async () => {
    const h = pendingHarness();
    await h.manager.place(signal(), approved);
    await h.manager.onBrokerUpdate({
      status: "CANCELLED",
      clientOrderId: "ord_1",
    });

    expect(h.orders.get("ord_1")?.status).toBe("CANCELLED");
    expect(h.events.filter((e) => e.name === "ORDER_FILLED")).toHaveLength(0);
  });

  it("surfaces an update for an order we never placed, rather than dropping it", async () => {
    const h = pendingHarness();
    await h.manager.onBrokerUpdate({
      status: "CANCELLED",
      clientOrderId: "ord_nope",
    });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.context).toMatchObject({ orderId: "ord_nope" });
  });
});

describe("the decision price reaches the broker (plan/19 §5)", () => {
  it("passes the signal's price as referencePrice for a MARKET order", async () => {
    // Without it a FYERS entry carrying a stop cannot express the leg as an
    // offset, and the adapter refuses the order outright.
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 100 });
    const h = harness({ broker });
    await h.manager.place(
      signal({ stopLoss: 95, target: 110 }),
      approved,
    );

    expect(broker.submitted[0]).toMatchObject({
      type: "MARKET",
      referencePrice: 100,
      stopLoss: 95,
      takeProfit: 110,
    });
  });
});
