import { describe, expect, it } from "vitest";
import type { Order } from "@neelkanth/core";
import { buildDailyTrades } from "./trades";

const order = (overrides: Partial<Order>): Order => ({
  orderId: "order",
  signalId: "signal",
  strategyId: "strategy",
  symbol: "NSE:HDFC-EQ",
  side: "BUY",
  qty: 5,
  type: "MARKET",
  status: "FILLED",
  mode: "paper",
  filledPrice: 1550,
  filledAt: 1,
  charges: 4.5,
  createdAt: 1,
  ...overrides,
});

describe("buildDailyTrades", () => {
  it("pairs buy and sell fills and subtracts both charges", () => {
    const [trade] = buildDailyTrades([
      order({ orderId: "buy", side: "BUY", filledAt: 1 }),
      order({
        orderId: "sell",
        side: "SELL",
        filledPrice: 1570,
        filledAt: 2,
      }),
    ]);

    expect(trade).toMatchObject({
      buyOrderId: "buy",
      sellOrderId: "sell",
      qty: 5,
      grossPnl: 100,
      charges: 9,
      pnl: 91,
    });
  });

  it("matches partial quantities FIFO", () => {
    const trades = buildDailyTrades([
      order({ orderId: "buy-1", qty: 3, filledAt: 1 }),
      order({ orderId: "buy-2", qty: 4, filledAt: 2, filledPrice: 1560 }),
      order({
        orderId: "sell",
        side: "SELL",
        qty: 5,
        filledAt: 3,
        filledPrice: 1570,
      }),
    ]);

    expect(trades.map((trade) => [trade.buyOrderId, trade.qty])).toEqual([
      ["buy-1", 3],
      ["buy-2", 2],
    ]);
  });
});
