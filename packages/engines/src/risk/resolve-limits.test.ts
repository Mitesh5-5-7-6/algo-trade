import { describe, expect, it } from "vitest";
import type { RiskLimits, RiskRules } from "@neelkanth/core";
import { resolveLimits } from "./resolve-limits.js";

const global: RiskLimits = {
  maxDailyLoss: 5000,
  maxPositionSize: 100,
  maxCapitalPerTrade: 50000,
  maxOpenPositions: 5,
  maxExposure: 0.8,
};

describe("resolveLimits (plan/14 §4 — override may only be stricter)", () => {
  it("returns the global limits when there is no override", () => {
    expect(resolveLimits(global, null)).toEqual(global);
  });

  it("tightens a limit when the override is stricter", () => {
    const override: RiskRules = { maxPositionSize: 20, maxDailyLoss: 1000 };
    const resolved = resolveLimits(global, override);
    expect(resolved.maxPositionSize).toBe(20);
    expect(resolved.maxDailyLoss).toBe(1000);
  });

  it("IGNORES a looser override — global is the outer envelope", () => {
    const override: RiskRules = {
      maxPositionSize: 500, // looser than global 100
      maxExposure: 0.99, // looser than global 0.8
    };
    const resolved = resolveLimits(global, override);
    expect(resolved.maxPositionSize).toBe(100);
    expect(resolved.maxExposure).toBe(0.8);
  });

  it("only touches the fields the override provides", () => {
    const resolved = resolveLimits(global, { maxOpenPositions: 2 });
    expect(resolved.maxOpenPositions).toBe(2);
    expect(resolved.maxCapitalPerTrade).toBe(global.maxCapitalPerTrade);
  });
});
