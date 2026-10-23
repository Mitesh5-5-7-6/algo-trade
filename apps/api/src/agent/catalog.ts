import { createPatternRegistry } from "@neelkanth/patterns";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { strategyEligibility } from "../counterfactual/eligibility.js";
import type { ProposalCatalog } from "./proposal.js";

/**
 * The catalog a proposal is checked against (Phase 12 D3): the detector
 * catalog, the strategies the counterfactual can replay on every one of these
 * instruments, and each strategy's own parameter schema — definitions only;
 * nothing here runs or changes a strategy.
 */
export function proposalCatalog(symbols: readonly string[]): ProposalCatalog {
  const held = new Set(symbols);
  const strategies = createStrategyRegistry()
    .types()
    .filter((type) =>
      symbols.every((s) =>
        strategyEligibility(s, "5m", held).some(
          (e) => e.type === type && e.eligible,
        ),
      ),
    );
  const registry = createStrategyRegistry();
  return {
    patterns: createPatternRegistry()
      .catalog()
      .map((d) => d.patternId),
    strategies,
    symbols: [...symbols].sort(),
    checkParams(strategyType, params) {
      try {
        // The strategy's own paramsSchema decides (the same parse an
        // operator's config meets at enable time); the instance is dropped.
        registry.instantiate(strategyType, params, symbols[0] ?? "X");
        return null;
      } catch (e) {
        return e instanceof Error
          ? e.message.split("\n").slice(0, 6).join(" ")
          : String(e);
      }
    },
  };
}
