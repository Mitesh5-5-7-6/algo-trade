import { describe, expect, it } from "vitest";
import type { Position } from "@neelkanth/core";
import { computePortfolio } from "./portfolio.js";

function position(overrides: Partial<Position>): Position {
  return {
    positionId: "p",
    symbol: "NSE:X-EQ",
    strategyId: "s",
    side: "LONG",
    qty: 10,
    avgEntryPrice: 100,
    status: "OPEN",
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: 0,
    mode: "paper",
    ...overrides,
  };
}

describe("computePortfolio (plan/13 §4)", () => {
  it("aggregates invested/current value, available capital, and exposure", () => {
    const positions = [
      position({ symbol: "NSE:A-EQ", qty: 10, avgEntryPrice: 100 }), // invested 1000
      position({ symbol: "NSE:B-EQ", qty: 20, avgEntryPrice: 50 }), // invested 1000
    ];
    const prices: Record<string, number> = { "NSE:A-EQ": 110, "NSE:B-EQ": 45 };
    const p = computePortfolio(
      positions,
      (s) => prices[s] ?? null,
      100_000,
      500, // realized today
    );
    expect(p.investedValue).toBe(2000);
    expect(p.currentValue).toBe(10 * 110 + 20 * 45); // 1100 + 900 = 2000
    expect(p.availableCapital).toBe(100_000 - 2000 + 500);
    expect(p.exposure).toBeCloseTo(0.02, 6);
  });

  it("falls back to entry price when the feed has no live price", () => {
    const p = computePortfolio(
      [position({ qty: 10, avgEntryPrice: 100 })],
      () => null,
      100_000,
      0,
    );
    expect(p.currentValue).toBe(1000); // entry-price fallback
  });

  it("is empty and fully available with no open positions", () => {
    const p = computePortfolio([], () => null, 100_000, 0);
    expect(p.investedValue).toBe(0);
    expect(p.availableCapital).toBe(100_000);
    expect(p.exposure).toBe(0);
  });
});
