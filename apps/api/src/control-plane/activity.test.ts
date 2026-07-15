import { describe, expect, it } from "vitest";
import type { Order, RiskLog, Signal } from "@neelkanth/core";
import { buildActivityFeed } from "./activity.js";

function signal(over: Partial<Signal>): Signal {
  return {
    side: "BUY",
    symbol: "NSE:INFY-EQ",
    reason: "rsi re-cross 30",
    ts: 1000,
    ...over,
  } as unknown as Signal;
}

function order(over: Partial<Order>): Order {
  return {
    orderId: "ord_1",
    side: "BUY",
    qty: 50,
    symbol: "NSE:INFY-EQ",
    status: "FILLED",
    filledPrice: 100,
    filledAt: 2000,
    createdAt: 1500,
    ...over,
  } as unknown as Order;
}

function risk(over: Partial<RiskLog>): RiskLog {
  return {
    symbol: "NSE:HDFCBANK-EQ",
    reason: "daily loss at 82%",
    ts: 3000,
    ...over,
  } as unknown as RiskLog;
}

describe("buildActivityFeed (plan/06 §4)", () => {
  it("merges the three sources newest-first", () => {
    const feed = buildActivityFeed(
      [signal({ ts: 1000 })],
      [order({ filledAt: 2000 })],
      [risk({ ts: 3000 })],
      10,
    );
    expect(feed.map((e) => e.kind)).toEqual(["risk_block", "fill", "signal"]);
  });

  it("drops HOLD signals — recorded, but not activity", () => {
    expect(buildActivityFeed([signal({ side: "HOLD" })], [], [], 10)).toEqual(
      [],
    );
  });

  it("formats a fill with its ticker and price", () => {
    const [entry] = buildActivityFeed(
      [],
      [
        order({
          status: "FILLED",
          orderId: "ord_9",
          side: "BUY",
          qty: 80,
          symbol: "NSE:INFY-EQ",
          filledPrice: 1512.2,
        }),
      ],
      [],
      10,
    );
    expect(entry?.kind).toBe("fill");
    expect(entry?.message).toBe("ORDER_FILLED ord_9 BUY 80 INFY @ 1512.20");
  });

  it("formats a rejection from its status", () => {
    const [entry] = buildActivityFeed(
      [],
      [
        order({
          status: "REJECTED",
          orderId: "ord_2",
          side: "SELL",
          qty: 100,
          symbol: "NSE:AXISBANK-EQ",
          filledPrice: undefined,
          filledAt: undefined,
        }),
      ],
      [],
      10,
    );
    expect(entry?.message).toBe("ORDER_REJECTED ord_2 SELL 100 AXISBANK");
  });

  it("respects the limit after merging", () => {
    const signals = Array.from({ length: 5 }, (_, i) => signal({ ts: i }));
    expect(buildActivityFeed(signals, [], [], 3)).toHaveLength(3);
  });
});
