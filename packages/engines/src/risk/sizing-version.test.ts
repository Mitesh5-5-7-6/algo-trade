import { describe, expect, it } from "vitest";
import { RiskLimitsSchema } from "@neelkanth/core";
import { SIZING_MODEL_VERSION, sizeEquity } from "./sizing.js";

/**
 * Task 4.5, design Q3: the position-sizing version a replay declares is
 * pinned to the arithmetic, as the cost and slippage versions are. Change how
 * a quantity is sized and this fails until the outputs move to a new version.
 */
const PINNED: Record<string, number[]> = { "1": [500, 10, 20] };

describe("the sizing model version is pinned to its arithmetic (§4.5)", () => {
  it("equity sizing", () => {
    const portfolio = {
      allocatedCapital: 100_000,
      investedValue: 0,
      availableCapital: 100_000,
    };
    const limits = RiskLimitsSchema.parse({
      maxDailyLoss: 5000,
      maxPositionSize: 1000,
      maxCapitalPerTrade: 50_000,
      maxOpenPositions: 5,
      maxExposure: 0.8,
      riskPerTrade: 0.01,
    });
    const quantities = [
      { entryPrice: 100, stopPrice: 98 },
      { entryPrice: 100, stopPrice: 99.5, qtyProposal: 10 },
      { entryPrice: 2500, stopPrice: 2450 },
    ].map((c) => sizeEquity({ ...c, portfolio, limits, lotSize: 1 }).quantity);
    expect(quantities).toEqual(PINNED[SIZING_MODEL_VERSION]);
  });
});
