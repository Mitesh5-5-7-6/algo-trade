import type { CandleInterval } from "@neelkanth/core";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { replayExclusion, type ReplayExclusion } from "../replay/run.js";

/** One registered strategy, and whether this dataset can evaluate it. */
export interface StrategyEligibility {
  type: string;
  params: Record<string, unknown>;
  eligible: boolean;
  /** Present exactly when not eligible — the replay's own refusal. */
  exclusion?: ReplayExclusion;
}

/**
 * Every registered strategy, evaluated or excluded with its reason (Phase 6
 * D1). Nothing is dropped: a matrix that silently lists three strategies
 * reads as "the library is three strategies".
 *
 * `params` names a strategy's configuration; a type it does not name runs at
 * its defaults (`{}`).
 */
export function strategyEligibility(
  symbol: string,
  interval: CandleInterval,
  heldSymbols: ReadonlySet<string>,
  params: Readonly<Record<string, Record<string, unknown>>> = {},
): StrategyEligibility[] {
  return createStrategyRegistry()
    .types()
    .map((type) => {
      const chosen = params[type] ?? {};
      const exclusion = replayExclusion(
        type,
        chosen,
        symbol,
        interval,
        heldSymbols,
      );
      return exclusion === null
        ? { type, params: chosen, eligible: true }
        : { type, params: chosen, eligible: false, exclusion };
    });
}
