import { describe, expect, it } from "vitest";
import type { Order, RiskDecision, Signal } from "@neelkanth/core";
import type { EventName } from "@neelkanth/contracts";
import { ScriptedFakeBroker } from "@neelkanth/broker";
import { OrderManager, type ExecutionBroker } from "./order-manager.js";
import type { OrderPorts } from "./ports.js";

function harness(
  opts: {
    broker?: ExecutionBroker;
    tradingEnabled?: boolean;
    persistReturns?: boolean;
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
