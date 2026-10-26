import { describe, expect, it } from "vitest";
import type { Order, Position } from "@neelkanth/core";
import type { PaperBrokerOrderDoc } from "@neelkanth/db";
import {
  reconcilePaperBook,
  type PaperReconciliationPorts,
} from "./paper-reconciliation.js";

const NOW = 1_700_000_000_000;
const SYMBOL = "NSE:RECON-EQ";

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "pos_1",
    symbol: SYMBOL,
    strategyId: "str_1",
    side: "LONG",
    qty: 10,
    avgEntryPrice: 100,
    status: "OPEN",
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: NOW - 10_000,
    mode: "paper",
    ...overrides,
  };
}

function brokerFill(
  overrides: Partial<PaperBrokerOrderDoc> = {},
): PaperBrokerOrderDoc {
  return {
    clientOrderId: "broker_order",
    brokerOrderId: "paper_1",
    symbol: SYMBOL,
    side: "BUY",
    qty: 10,
    type: "MARKET",
    status: "FILLED",
    filledPrice: 100,
    filledQty: 10,
    slippage: 0.1,
    charges: 2,
    filledAt: NOW - 10_000,
    recordedAt: NOW - 10_000,
    ...overrides,
  };
}

function localOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: "broker_order",
    signalId: "sig_1",
    strategyId: "str_1",
    symbol: SYMBOL,
    side: "BUY",
    qty: 10,
    type: "MARKET",
    status: "PLACED",
    mode: "paper",
    createdAt: NOW,
    ...overrides,
  };
}

function harness(overrides: Partial<PaperReconciliationPorts> = {}) {
  const calls: string[] = [];
  const closed: { order: Order; fill: PaperBrokerOrderDoc }[] = [];
  const ports: PaperReconciliationPorts = {
    findOpenPositions: () => [],
    findOrders: () => Promise.resolve([]),
    findInFlightOrders: () => Promise.resolve([]),
    findOrder: () => Promise.resolve(null),
    findBookOrders: () => Promise.resolve([]),
    findBookOrder: () => Promise.resolve(null),
    findAllFills: () => Promise.resolve([]),
    disableTrading: () => {
      calls.push("disableTrading");
      return Promise.resolve();
    },
    persistRiskEvent: () => {
      calls.push("persistRiskEvent");
      return Promise.resolve();
    },
    publishMismatch: () => {
      calls.push("publishMismatch");
      return Promise.resolve();
    },
    reconcileClose: (order, fill) => {
      closed.push({ order, fill });
      return Promise.resolve();
    },
    now: () => NOW,
    ...overrides,
  };
  return { ports, calls, closed };
}

describe("paper broker reconciliation (Phase 14 D4)", () => {
  it("does nothing when broker fills and open position net quantities agree", async () => {
    const h = harness({
      findOpenPositions: () => [position()],
      findAllFills: () => Promise.resolve([brokerFill()]),
    });

    expect(await reconcilePaperBook(h.ports)).toBeNull();
    expect(h.calls).toEqual([]);
    expect(h.closed).toEqual([]);
  });

  it("persists and publishes a mismatch after durably disabling new trading", async () => {
    const h = harness({
      findOrders: () => Promise.resolve([localOrder()]),
      findBookOrders: () =>
        Promise.resolve([brokerFill({ recordedAt: NOW, status: "FILLED" })]),
    });

    const event = await reconcilePaperBook(h.ports);

    expect(event?.mismatches).toContainEqual(
      expect.objectContaining({
        kind: "ORDER",
        orderId: "broker_order",
        reason: "order status differs",
      }),
    );
    expect(h.calls).toEqual([
      "disableTrading",
      "persistRiskEvent",
      "publishMismatch",
    ]);
  });

  it("checks an older in-flight order against the broker book at boot", async () => {
    const pendingOrder = localOrder({
      createdAt: NOW - 2 * 86_400_000,
      status: "PENDING",
    });
    const h = harness({
      findInFlightOrders: () => Promise.resolve([pendingOrder]),
    });

    const event = await reconcilePaperBook(h.ports);

    expect(event?.mismatches).toContainEqual(
      expect.objectContaining({
        kind: "ORDER",
        orderId: "broker_order",
        reason: "order exists in trading orders but not broker book",
      }),
    );
  });

  it("closes a local position at the paper broker's final fill price when broker net is flat", async () => {
    const h = harness({
      findOpenPositions: () => [position()],
      findAllFills: () =>
        Promise.resolve([
          brokerFill({ clientOrderId: "entry", filledAt: NOW - 20_000 }),
          brokerFill({
            clientOrderId: "exit",
            brokerOrderId: "paper_2",
            side: "SELL",
            filledPrice: 105,
            slippage: 0.2,
            charges: 3,
            filledAt: NOW - 10_000,
          }),
        ]),
    });

    const event = await reconcilePaperBook(h.ports);

    expect(event?.mismatches).toContainEqual(
      expect.objectContaining({
        kind: "POSITION",
        symbol: SYMBOL,
        tradingValue: "10",
        brokerValue: "0",
      }),
    );
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]?.order).toMatchObject({
      side: "SELL",
      qty: 10,
      status: "FILLED",
      filledPrice: 105,
      exitReason: "BROKER_RECONCILIATION",
    });
    expect(h.closed[0]?.fill.clientOrderId).toBe("exit");
  });

  it("prorates broker costs across all local positions being reconciled", async () => {
    const h = harness({
      findOpenPositions: () => [
        position({ positionId: "pos_a", qty: 10 }),
        position({ positionId: "pos_b", strategyId: "str_2", qty: 5 }),
      ],
      findAllFills: () =>
        Promise.resolve([
          brokerFill({ clientOrderId: "entry", filledAt: NOW - 20_000 }),
          brokerFill({
            clientOrderId: "exit",
            side: "SELL",
            filledPrice: 105,
            slippage: 0.2,
            charges: 3,
            filledAt: NOW - 10_000,
          }),
        ]),
    });

    await reconcilePaperBook(h.ports);

    expect(h.closed.map(({ order }) => order.charges)).toEqual([2, 1]);
    expect(h.closed.map(({ order }) => order.slippage)).toEqual([
      expect.closeTo(0.2 * (10 / 15)),
      expect.closeTo(0.2 * (5 / 15)),
    ]);
  });

  it("does not synthesize a close from an incomplete broker fill", async () => {
    const h = harness({
      findOpenPositions: () => [position()],
      findAllFills: () =>
        Promise.resolve([
          brokerFill({
            side: "SELL",
            filledPrice: undefined,
            filledAt: undefined,
          }),
        ]),
    });

    const event = await reconcilePaperBook(h.ports);

    expect(event?.mismatches).toContainEqual(
      expect.objectContaining({
        kind: "ORDER",
        orderId: "broker_order",
        reason: "filled broker order is missing fill details",
      }),
    );
    expect(h.closed).toEqual([]);
  });
});
