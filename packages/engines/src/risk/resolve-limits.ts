import type { RiskLimits, RiskRules } from "@neelkanth/core";

/**
 * Merge a strategy's override into the global limits with the rule that an
 * override may only be **stricter**, never looser (plan/14 §4). Every limit is
 * an upper bound, so "stricter" is the minimum — global limits are the
 * operator's outer safety envelope and a per-strategy config must never widen
 * it. Pure, so it's tested directly.
 */
export function resolveLimits(
  global: RiskLimits,
  override: RiskRules | null,
): RiskLimits {
  if (override === null) return global;
  const tighten = (g: number, o: number | undefined): number =>
    o === undefined ? g : Math.min(g, o);
  return {
    maxDailyLoss: tighten(global.maxDailyLoss, override.maxDailyLoss),
    maxPositionSize: tighten(global.maxPositionSize, override.maxPositionSize),
    maxCapitalPerTrade: tighten(
      global.maxCapitalPerTrade,
      override.maxCapitalPerTrade,
    ),
    maxOpenPositions: tighten(
      global.maxOpenPositions,
      override.maxOpenPositions,
    ),
    maxExposure: tighten(global.maxExposure, override.maxExposure),
  };
}
