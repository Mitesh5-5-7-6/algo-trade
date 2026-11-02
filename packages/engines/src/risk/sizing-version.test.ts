import { describe, expect, it } from "vitest";
import { RiskLimitsSchema, type Instrument } from "@neelkanth/core";
import {
  SIZING_MODEL_VERSION,
  resolveFnoLimits,
  sizeEquity,
  sizeFno,
} from "./sizing.js";

/**
 * Task 4.5, design Q3: the position-sizing version a replay declares is
 * pinned to the arithmetic, as the cost and slippage versions are. Change how
 * a quantity is sized and this fails until the outputs move to a new version.
 */
const PINNED: Record<string, number[]> = { "1": [500, 10, 20] };
const PINNED_FNO: Record<string, number[]> = { "1": [195, 30, 0, 45] };

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

  /**
   * Task 14.10: F&O sizing is pinned the same way. Each value below was worked
   * by hand from the lot arithmetic (ARCHITECTURE_DECISION §20.2), not copied
   * from a run: ₹2,000 risk budget, ₹50,000 capital and ₹80,000 exposure.
   *
   *   option lot 65, 100 → 90:      risk ₹650/lot → 3; capital ₹6,500 → 7  → 3 lots = 195
   *   option lot 30, 300 → 250:     risk ₹1,500 → 1;   capital ₹9,000 → 5  → 1 lot  = 30
   *   future lot 75, 25000 → 24990: risk ₹750 → 2;     notional ₹18.75L → 0 → 0
   *   future lot 15, 1000 → 990:    risk ₹150 → 13;    notional ₹15,000 → 3 → 3 lots = 45
   *
   * The third pins the NOTIONAL basis (§20.4): a margin percentage slipped in
   * for futures would size it above zero and fail here.
   */
  it("F&O sizing", () => {
    const portfolio = {
      allocatedCapital: 100_000,
      investedValue: 0,
      availableCapital: 100_000,
    };
    const limits = resolveFnoLimits(
      RiskLimitsSchema.parse({
        maxDailyLoss: 5000,
        maxPositionSize: 1000,
        maxCapitalPerTrade: 50_000,
        maxOpenPositions: 5,
        maxExposure: 0.8,
        riskPerTrade: 0.01,
        fnoRiskPerTrade: 0.02,
      }),
    );
    const option = (lotSize: number): Instrument => ({
      symbol: "NSE:TEST-OPT",
      kind: "OPTION",
      lotSize,
      tickSize: 0.05,
      underlying: "TEST",
      strike: 100,
      optionType: "CE",
    });
    const future = (lotSize: number): Instrument => ({
      symbol: "NSE:TEST-FUT",
      kind: "FUTURE",
      lotSize,
      tickSize: 0.05,
      underlying: "TEST",
    });
    const quantities = [
      { instrument: option(65), entryPrice: 100, stopPrice: 90 },
      { instrument: option(30), entryPrice: 300, stopPrice: 250 },
      { instrument: future(75), entryPrice: 25_000, stopPrice: 24_990 },
      { instrument: future(15), entryPrice: 1_000, stopPrice: 990 },
    ].map(
      (c) =>
        sizeFno({
          ...c,
          symbol: c.instrument.symbol,
          portfolio,
          limits,
          openPositionCount: 0,
          opensNewPosition: true,
        }).quantity,
    );
    expect(quantities).toEqual(PINNED_FNO[SIZING_MODEL_VERSION]);
  });
});
