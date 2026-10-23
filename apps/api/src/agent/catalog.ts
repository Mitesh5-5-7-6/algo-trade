import { createPatternRegistry } from "@neelkanth/patterns";
import {
  BUILTIN_STRATEGIES,
  createStrategyRegistry,
} from "@neelkanth/strategies";
import { strategyEligibility } from "../counterfactual/eligibility.js";
import type { ProposalCatalog } from "./proposal.js";

/**
 * A variant as its strategy would run it (Phase 12 D3): the strategy's own
 * paramsSchema decides — the same parse an operator's config meets at enable
 * time — and every proposed parameter must come out of it exactly as given.
 * A schema drops a key it does not know and fills defaults, so without this
 * a variant naming `fast_ema` would parse, run as the defaults, and be
 * registered as a claim about a strategy nobody tested (12.5 acceptance F2).
 */
export function variantProblem(
  strategyType: string,
  params: Record<string, unknown>,
): string | null {
  const def = BUILTIN_STRATEGIES.find((d) => d.type === strategyType);
  if (def === undefined) return `no definition of ${strategyType}`;
  const parsed = def.paramsSchema.safeParse(params);
  if (!parsed.success)
    return parsed.error.issues
      .map((i) => `${i.path.join(".") || "params"}: ${i.message}`)
      .join("; ");
  const kept = parsed.data as Record<string, unknown>;
  const altered = Object.keys(params).filter(
    (k) =>
      !Object.hasOwn(kept, k) ||
      JSON.stringify(kept[k]) !== JSON.stringify(params[k]),
  );
  if (altered.length === 0) return null;
  const known = Object.keys(def.paramsSchema.parse({})).sort();
  return `${strategyType} does not take ${altered.join(", ")} as given — its parameters include ${known.join(", ")}`;
}

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
  return {
    patterns: createPatternRegistry()
      .catalog()
      .map((d) => d.patternId),
    strategies,
    symbols: [...symbols].sort(),
    checkParams: variantProblem,
  };
}
