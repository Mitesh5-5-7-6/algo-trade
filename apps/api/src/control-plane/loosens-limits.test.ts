import { describe, expect, it } from "vitest";
import { RiskLimitsSchema, type RiskLimits } from "@neelkanth/core";
import { loosensLimits } from "./routes.js";

/**
 * Task 14.10: the step-up decision on the F&O fields.
 *
 * A loosening needs the password; a tightening never does. The F&O limits are
 * optional and fall back to their equity counterparts, so the question is
 * whether the EFFECTIVE budget grows — and an absent lot ceiling is the
 * loosest value there is.
 */
const BASE: RiskLimits = {
  maxDailyLoss: 5_000,
  maxPositionSize: 100,
  maxCapitalPerTrade: 50_000,
  maxOpenPositions: 5,
  maxExposure: 0.8,
  riskPerTrade: 0.01,
  fnoRiskPerTrade: 0.02,
  fnoMaxLotsPerTrade: 2,
  fnoMaxCapitalPerTrade: 40_000,
  fnoMaxExposure: 0.6,
  fnoMaxOpenPositions: 3,
};

/** BASE without the named F&O fields, so they inherit. */
function without(...keys: (keyof RiskLimits)[]): RiskLimits {
  return RiskLimitsSchema.parse(
    Object.fromEntries(
      Object.entries(BASE).filter(([key]) =>
        keys.every((dropped) => dropped !== key),
      ),
    ),
  );
}

describe("loosensLimits on the F&O fields (task 14.10)", () => {
  it("does not ask for a password when nothing changes", () => {
    expect(loosensLimits(BASE, { ...BASE })).toBe(false);
  });

  it.each([
    ["fnoRiskPerTrade", { fnoRiskPerTrade: 0.03 }],
    ["fnoMaxLotsPerTrade", { fnoMaxLotsPerTrade: 3 }],
    ["fnoMaxCapitalPerTrade", { fnoMaxCapitalPerTrade: 45_000 }],
    ["fnoMaxExposure", { fnoMaxExposure: 0.7 }],
    ["fnoMaxOpenPositions", { fnoMaxOpenPositions: 4 }],
  ] as const)("raising %s is a loosening", (_field, change) => {
    expect(loosensLimits(BASE, { ...BASE, ...change })).toBe(true);
  });

  it.each([
    ["fnoRiskPerTrade", { fnoRiskPerTrade: 0.015 }],
    ["fnoMaxLotsPerTrade", { fnoMaxLotsPerTrade: 1 }],
    ["fnoMaxCapitalPerTrade", { fnoMaxCapitalPerTrade: 30_000 }],
    ["fnoMaxExposure", { fnoMaxExposure: 0.5 }],
    ["fnoMaxOpenPositions", { fnoMaxOpenPositions: 2 }],
  ] as const)("lowering %s is not", (_field, change) => {
    expect(loosensLimits(BASE, { ...BASE, ...change })).toBe(false);
  });

  /** null ceiling = no lot cap: removing one loosens though no number rose. */
  it("treats removing the lot ceiling as a loosening", () => {
    expect(loosensLimits(BASE, without("fnoMaxLotsPerTrade"))).toBe(true);
  });

  it("treats adding a lot ceiling where there was none as a tightening", () => {
    expect(loosensLimits(without("fnoMaxLotsPerTrade"), BASE)).toBe(false);
  });

  it("treats setting an absent F&O limit above the inherited equity value as a loosening", () => {
    // Inheriting riskPerTrade 1%; setting the F&O value to 2% grows the budget.
    const inheriting = without("fnoRiskPerTrade");
    expect(
      loosensLimits(inheriting, { ...inheriting, fnoRiskPerTrade: 0.02 }),
    ).toBe(true);
  });

  it("treats setting an absent F&O limit below the inherited equity value as a tightening", () => {
    const inheriting = without("fnoRiskPerTrade");
    expect(
      loosensLimits(inheriting, { ...inheriting, fnoRiskPerTrade: 0.005 }),
    ).toBe(false);
  });

  it("treats clearing a tight F&O limit back to a looser inherited one as a loosening", () => {
    // fnoMaxCapitalPerTrade 40k is tighter than the equity 50k it would inherit.
    expect(loosensLimits(BASE, without("fnoMaxCapitalPerTrade"))).toBe(true);
  });

  it("treats clearing a loose F&O limit back to a tighter inherited one as a tightening", () => {
    // fnoRiskPerTrade 2% is looser than the equity 1% it would inherit.
    expect(loosensLimits(BASE, without("fnoRiskPerTrade"))).toBe(false);
  });
});
