import { describe, expect, it } from "vitest";
import type { Trade } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import { TradeEngine } from "./trade-engine.js";
import type { TradePorts } from "./ports.js";

/**
 * The Trade Engine turns fills into outcomes (ADR §9.2).
 *
 * These guard the properties research depends on: one round trip is one trade,
 * a redelivered fill changes nothing, costs stay separable from the result,
 * and a restart does not split one position into two trades.
 */

function harness(openTrades: Trade[] = []) {
  const saved: Trade[] = [];
  let counter = 0;
  const ports: TradePorts = {
    saveTrade: (trade) => {
      saved.push(trade);
      return Promise.resolve();
    },
    loadOpenTrades: () => Promise.resolve(openTrades),
  };
  const errors: unknown[] = [];
  const engine = new TradeEngine({
    ports,
    nextTradeId: () => `trd_${String(++counter)}`,
    onError: (error) => errors.push(error),
  });
  /** The latest saved state of a trade, by id. */
  const latest = (tradeId: string): Trade | undefined =>
    saved.filter((t) => t.tradeId === tradeId).at(-1);
  return { engine, saved, errors, latest };
}

const fill = (
  overrides: Partial<EventPayload<"ORDER_FILLED">> = {},
): EventPayload<"ORDER_FILLED"> => ({
  orderId: "ord_1",
  strategyId: "str_1",
  symbol: "NSE:X-EQ",
  side: "BUY",
  qty: 10,
  filledPrice: 100,
  slippage: 0.5,
  charges: 5,
  filledAt: 1_000,
  mode: "paper",
  ts: 1_000,
  ...overrides,
});

describe("TradeEngine — one round trip is one trade", () => {
  it("opens a trade on the entry fill", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill());

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      tradeId: "trd_1",
      side: "LONG",
      status: "OPEN",
      entryOrderId: "ord_1",
      entryPrice: 100,
      quantity: 10,
      openQuantity: 10,
      charges: 5,
      slippage: 0.5,
    });
    expect(h.saved[0]?.netPnl).toBeUndefined();
  });

  it("closes it on the opposite fill, with costs separable from the result", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill());
    await h.engine.onOrderFilled(
      fill({
        orderId: "ord_2",
        side: "SELL",
        filledPrice: 110,
        charges: 7,
        slippage: 0.25,
        filledAt: 2_000,
      }),
    );

    const closed = h.latest("trd_1");
    expect(closed).toMatchObject({
      status: "CLOSED",
      exitOrderId: "ord_2",
      exitPrice: 110,
      grossPnl: 100,
      charges: 12,
      slippage: 0.75,
      netPnl: 88,
      openQuantity: 0,
      closedAt: 2_000,
    });
    expect(h.engine.getOpen("str_1", "NSE:X-EQ")).toBeNull();
  });

  it("signs a SHORT the other way", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill({ side: "SELL", charges: 0 }));
    await h.engine.onOrderFilled(
      fill({ orderId: "ord_2", side: "BUY", filledPrice: 90, charges: 0 }),
    );

    expect(h.latest("trd_1")).toMatchObject({ side: "SHORT", grossPnl: 100 });
  });

  /**
   * The bus does not await its handlers and a broker can repeat an update, so
   * a redelivered fill must change nothing at all.
   */
  it("ignores a redelivered fill", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill());
    await h.engine.onOrderFilled(fill());

    expect(h.saved).toHaveLength(1);
  });
});

describe("TradeEngine — partial exits and adds", () => {
  /**
   * The reason gross P&L accumulates rather than being computed once at the
   * end: two exits at different prices. A single final calculation would price
   * the whole trade at the last exit and be wrong about both legs.
   */
  it("accumulates realised P&L across two exit legs", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill({ qty: 10, charges: 0 }));
    await h.engine.onOrderFilled(
      fill({
        orderId: "ord_2",
        side: "SELL",
        qty: 4,
        filledPrice: 110,
        charges: 0,
      }),
    );
    await h.engine.onOrderFilled(
      fill({
        orderId: "ord_3",
        side: "SELL",
        qty: 6,
        filledPrice: 100,
        charges: 0,
      }),
    );

    const closed = h.latest("trd_1");
    // 4 at +10 = 40, then 6 at 0 = 0. Neither 0 nor 100, which is what a
    // single end-of-trade calculation would have produced.
    expect(closed?.grossPnl).toBe(40);
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.quantity).toBe(10);
    expect(closed?.openQuantity).toBe(0);
  });

  it("stays open after a partial exit", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill({ qty: 10 }));
    await h.engine.onOrderFilled(
      fill({ orderId: "ord_2", side: "SELL", qty: 4, filledPrice: 110 }),
    );

    const trade = h.engine.getOpen("str_1", "NSE:X-EQ");
    expect(trade?.status).toBe("OPEN");
    expect(trade?.openQuantity).toBe(6);
    expect(trade?.grossPnl).toBe(40);
  });

  it("averages the entry when the position is added to", async () => {
    const h = harness();
    await h.engine.onOrderFilled(
      fill({ qty: 10, filledPrice: 100, charges: 0 }),
    );
    await h.engine.onOrderFilled(
      fill({ orderId: "ord_2", qty: 10, filledPrice: 120, charges: 0 }),
    );

    const trade = h.engine.getOpen("str_1", "NSE:X-EQ");
    expect(trade?.entryPrice).toBe(110);
    expect(trade?.quantity).toBe(20);
  });

  /**
   * A reversal is two trades, not one confused one — the same split the
   * Position Engine makes, so the two projections agree about history.
   */
  it("splits a reversal into a closed trade and a new one", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill({ qty: 10, charges: 0 }));
    await h.engine.onOrderFilled(
      fill({
        orderId: "ord_2",
        side: "SELL",
        qty: 15,
        filledPrice: 110,
        charges: 0,
        filledAt: 2_000,
      }),
    );

    expect(h.latest("trd_1")).toMatchObject({
      status: "CLOSED",
      side: "LONG",
      grossPnl: 100,
    });
    expect(h.latest("trd_2")).toMatchObject({
      status: "OPEN",
      side: "SHORT",
      entryPrice: 110,
      quantity: 5,
    });
    // Charges were consumed by the closing leg; counting them twice would
    // overstate the cost of the reversal.
    expect(h.latest("trd_2")?.charges).toBe(0);
  });
});

describe("TradeEngine — restart", () => {
  /**
   * Without hydration a restart mid-position opens a SECOND trade on the next
   * fill and leaves the first open forever: one position recorded as two
   * trades, neither of them true.
   */
  it("resumes an open trade rather than starting a second one", async () => {
    const existing: Trade = {
      tradeId: "trd_before_restart",
      strategyId: "str_1",
      symbol: "NSE:X-EQ",
      side: "LONG",
      mode: "paper",
      entryOrderId: "ord_old",
      entryTime: 500,
      entryPrice: 100,
      quantity: 10,
      openQuantity: 10,
      status: "OPEN",
      charges: 5,
      slippage: 0,
      grossPnl: 0,
      openedAt: 500,
    };
    const h = harness([existing]);
    await h.engine.hydrate();

    await h.engine.onOrderFilled(
      fill({ orderId: "ord_2", side: "SELL", filledPrice: 110, charges: 0 }),
    );

    expect(h.latest("trd_before_restart")).toMatchObject({
      status: "CLOSED",
      grossPnl: 100,
      netPnl: 95,
    });
    expect(h.saved.filter((t) => t.status === "OPEN")).toHaveLength(0);
  });
});

describe("TradeEngine — failures stay contained", () => {
  /**
   * Losing a trade record is bad; losing the system's view of what it holds is
   * worse. A persistence failure here must not propagate into the bus and stop
   * the position projection behind it.
   */
  it("routes a save failure to onError instead of throwing", async () => {
    const errors: unknown[] = [];
    const engine = new TradeEngine({
      ports: {
        saveTrade: () => Promise.reject(new Error("mongo down")),
        loadOpenTrades: () => Promise.resolve([]),
      },
      nextTradeId: () => "trd_1",
      onError: (error) => errors.push(error),
    });

    await expect(engine.onOrderFilled(fill())).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
