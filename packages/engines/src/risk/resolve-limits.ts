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
  /**
   * The F&O limits are optional on both sides, so "stricter" is the minimum of
   * whichever are present. Spread conditionally rather than assigning
   * `undefined`: `exactOptionalPropertyTypes` distinguishes an absent field
   * from one explicitly set to undefined, and only the former means "fall back
   * to the equity counterpart".
   */
  const tightenOptional = (
    g: number | undefined,
    o: number | undefined,
  ): number | undefined => {
    if (g === undefined) return o;
    if (o === undefined) return g;
    return Math.min(g, o);
  };
  const optional = (
    key: string,
    value: number | undefined,
  ): Record<string, number> => (value === undefined ? {} : { [key]: value });

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
    riskPerTrade: tighten(global.riskPerTrade, override.riskPerTrade),
    // Carried through explicitly. Rebuilding the object field-by-field means
    // anything not named here is silently dropped — which would leave every
    // F&O limit undefined after resolution, falling back to the equity budget
    // without a word.
    ...optional(
      "fnoRiskPerTrade",
      tightenOptional(global.fnoRiskPerTrade, override.fnoRiskPerTrade),
    ),
    ...optional(
      "fnoMaxLotsPerTrade",
      tightenOptional(global.fnoMaxLotsPerTrade, override.fnoMaxLotsPerTrade),
    ),
    ...optional(
      "fnoMaxCapitalPerTrade",
      tightenOptional(
        global.fnoMaxCapitalPerTrade,
        override.fnoMaxCapitalPerTrade,
      ),
    ),
    ...optional(
      "fnoMaxExposure",
      tightenOptional(global.fnoMaxExposure, override.fnoMaxExposure),
    ),
    ...optional(
      "fnoMaxOpenPositions",
      tightenOptional(global.fnoMaxOpenPositions, override.fnoMaxOpenPositions),
    ),
  };
}
