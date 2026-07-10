import { StrategyRegistry } from "./registry.js";
import { emaCrossover } from "./ema-crossover.js";
import { rsiReversion } from "./rsi-reversion.js";
import { orb } from "./orb.js";

export * from "./contract.js";
export * from "./registry.js";
export * from "./shared.js";
export * from "./ema-crossover.js";
export * from "./rsi-reversion.js";
export * from "./orb.js";

/** The strategies available in Phase 1 (plan/28 §3: one trend, one breakout,
 *  one mean-reversion first). The remaining five (plan/16) register here as
 *  they land. */
export const BUILTIN_STRATEGIES = [emaCrossover, rsiReversion, orb] as const;

/** Register the built-in strategy library into a registry (plan/15 §4). */
export function registerBuiltinStrategies(registry: StrategyRegistry): void {
  registry.register(emaCrossover);
  registry.register(rsiReversion);
  registry.register(orb);
}

/** A registry pre-loaded with the built-in strategies. */
export function createStrategyRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();
  registerBuiltinStrategies(registry);
  return registry;
}
