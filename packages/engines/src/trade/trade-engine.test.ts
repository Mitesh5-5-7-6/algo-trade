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
    // Restart-durable idempotency (D5). These fixtures are per-test, so
    // nothing a previous lifetime wrote can be found.
    findTradeByOrderId: () => Promise.resolve(null),
    resolvePositionId: () => "pos_1",
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
    await h.engine.onOrderFilled(fill({ qty: 10, charges: 0, slippage: 0 }));
    await h.engine.onOrderFilled(
      fill({
        orderId: "ord_2",
        side: "SELL",
        qty: 15,
        filledPrice: 110,
        charges: 30,
        slippage: 1.5,
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
  });

  /**
   * The engine must pass the order's cost through the pro-rata split (design
   * §5.1 Q1), not around it. Charging the whole order to the closing leg —
   * the ported behaviour — makes the closing trade pay for an entry it never
   * made and the new trade appear to enter for free.
   */
  it("splits a reversing order's cost across both trades by quantity", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill({ qty: 10, charges: 0, slippage: 0 }));
    await h.engine.onOrderFilled(
      fill({
        orderId: "ord_2",
        side: "SELL",
        qty: 15,
        filledPrice: 110,
        charges: 30,
        slippage: 1.5,
        filledAt: 2_000,
      }),
    );

    // 10 of 15 closes the long, 5 of 15 opens the short.
    expect(h.latest("trd_1")).toMatchObject({
      charges: 20,
      slippage: 1,
      netPnl: 80,
    });
    expect(h.latest("trd_2")).toMatchObject({ charges: 10, slippage: 0.5 });
    // The two legs reconcile to what the broker charged — nothing lost or
    // counted twice.
    expect(
      (h.latest("trd_1")?.charges ?? 0) + (h.latest("trd_2")?.charges ?? 0),
    ).toBe(30);
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
      orderIds: ["ord_old"],
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
        findTradeByOrderId: () => Promise.resolve(null),
        resolvePositionId: () => null,
      },
      nextTradeId: () => "trd_1",
      onError: (error) => errors.push(error),
    });

    await expect(engine.onOrderFilled(fill())).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

/**
 * What the entry stood on reaches the trade (§2.1, design §2 drifts 1 and 3).
 *
 * The engine reads `ORDER_FILLED` and nothing else, so it can only record what
 * the fill carries — and it must take it from the fill that OPENED the trade.
 */
describe("TradeEngine — what the entry stood on (§2.1)", () => {
  const BAR_A = {
    symbol: "NSE:X-EQ",
    interval: "5m" as const,
    barTs: 900,
    source: "LIVE_TICK" as const,
  };
  const BAR_B = {
    ...BAR_A,
    barTs: 1_900,
    source: "BROKER_HISTORICAL" as const,
  };

  it("stamps the entry fill's provenance and market context", async () => {
    const h = harness();
    await h.engine.onOrderFilled(
      fill({
        dataProvenance: BAR_A,
        marketContext: { volumeQuality: "SUSPECT" },
      }),
    );

    expect(h.latest("trd_1")).toMatchObject({
      dataProvenance: BAR_A,
      marketContext: { volumeQuality: "SUSPECT" },
    });
  });

  it("keeps the entry's when a fill made on another bar closes the trade", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill({ dataProvenance: BAR_A }));
    await h.engine.onOrderFilled(
      fill({
        orderId: "ord_2",
        side: "SELL",
        filledPrice: 110,
        filledAt: 2_000,
        dataProvenance: BAR_B,
      }),
    );

    expect(h.latest("trd_1")).toMatchObject({
      status: "CLOSED",
      dataProvenance: BAR_A,
    });
  });

  /**
   * The reversing order is the decision that opened the new trade, so the new
   * trade stands on THAT order's bar — not the one the closed trade entered on.
   */
  it("gives a reversal's new trade the reversing order's provenance", async () => {
    const h = harness();
    await h.engine.onOrderFilled(fill({ qty: 10, dataProvenance: BAR_A }));
    await h.engine.onOrderFilled(
      fill({
        orderId: "ord_2",
        side: "SELL",
        qty: 15,
        filledPrice: 110,
        filledAt: 2_000,
        dataProvenance: BAR_B,
      }),
    );

    expect(h.latest("trd_1")?.dataProvenance).toEqual(BAR_A);
    expect(h.latest("trd_2")?.dataProvenance).toEqual(BAR_B);
  });
});

/**
 * Limit L2 (design §5.7), settled: memory moving ahead of Mongo is deliberate.
 *
 * Every save writes the WHOLE trade, so a failed save is healed by the next
 * save of the same trade. The tempting "fix" — advance memory only after the
 * write lands — is the bug: a lost entry save would leave no open trade, and
 * the closing fill would open a phantom on the other side.
 */
describe("TradeEngine — a failed save is healed by the next one (§2.4, L2)", () => {
  it("records the full round trip after the entry save failed", async () => {
    const saved: Trade[] = [];
    let failNext = true;
    const errors: unknown[] = [];
    const engine = new TradeEngine({
      ports: {
        saveTrade: (trade) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error("mongo blip"));
          }
          saved.push(trade);
          return Promise.resolve();
        },
        loadOpenTrades: () => Promise.resolve([]),
        findTradeByOrderId: () => Promise.resolve(null),
        resolvePositionId: () => "pos_1",
      },
      nextTradeId: () => `trd_${String(saved.length + errors.length + 1)}`,
      onError: (error) => errors.push(error),
    });

    await engine.onOrderFilled(fill());
    expect(errors).toHaveLength(1); // the blip was reported, not swallowed
    await engine.onOrderFilled(
      fill({
        orderId: "ord_2",
        side: "SELL",
        filledPrice: 110,
        filledAt: 2_000,
      }),
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      tradeId: "trd_1",
      side: "LONG",
      status: "CLOSED",
      entryOrderId: "ord_1",
      entryPrice: 100,
      exitOrderId: "ord_2",
      orderIds: ["ord_1", "ord_2"],
    });
  });
});

/**
 * Task 2.7 found this through the real runtime: fills applied out of order.
 *
 * The bus does not await its handlers, so two fills can be in flight at once.
 * The engine awaits a durable lookup BEFORE applying a fill, so whichever
 * lookup returned first applied first — a BUY then SELL round trip was
 * recorded as a SHORT entered on the SELL. And the same fill delivered twice
 * concurrently passed the in-memory guard twice. Fills are therefore applied
 * one at a time, in the order delivered.
 */
describe("TradeEngine — fills apply in the order delivered (§2.7)", () => {
  /** A lookup that answers slowly for one order, at once for the rest. */
  function slowFor(slowOrderId: string) {
    const saved: Trade[] = [];
    const engine = new TradeEngine({
      ports: {
        saveTrade: (trade) => {
          saved.push(trade);
          return Promise.resolve();
        },
        loadOpenTrades: () => Promise.resolve([]),
        findTradeByOrderId: (orderId) =>
          new Promise((resolve) => {
            setTimeout(
              () => {
                resolve(null);
              },
              orderId === slowOrderId ? 30 : 0,
            );
          }),
        resolvePositionId: () => "pos_1",
      },
      nextTradeId: () => `trd_${String(saved.length + 1)}`,
      onError: () => undefined,
    });
    const latest = (tradeId: string) =>
      saved.filter((t) => t.tradeId === tradeId).at(-1);
    return { engine, saved, latest };
  }

  it("does not let a fast exit overtake a slow entry", async () => {
    const h = slowFor("ord_1");
    await Promise.all([
      h.engine.onOrderFilled(fill()),
      h.engine.onOrderFilled(
        fill({
          orderId: "ord_2",
          side: "SELL",
          filledPrice: 110,
          filledAt: 2_000,
        }),
      ),
    ]);

    expect(h.latest("trd_1")).toMatchObject({
      side: "LONG",
      status: "CLOSED",
      entryOrderId: "ord_1",
      exitOrderId: "ord_2",
      grossPnl: 100,
    });
  });

  it("applies a fill delivered twice at once only once", async () => {
    const h = slowFor("ord_1");
    await Promise.all([
      h.engine.onOrderFilled(fill()),
      h.engine.onOrderFilled(fill()),
    ]);

    expect(h.engine.getOpen("str_1", "NSE:X-EQ")).toMatchObject({
      quantity: 10,
      openQuantity: 10,
    });
  });
});
