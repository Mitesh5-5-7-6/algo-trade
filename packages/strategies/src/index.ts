import { StrategyRegistry } from "./registry.js";
import { emaCrossover } from "./ema-crossover.js";
import { rsiReversion } from "./rsi-reversion.js";
import { orb } from "./orb.js";
import { indexOptionMomentum } from "./index-option-momentum.js";
import { indexOptionFlowBreakout } from "./index-option-flow.js";
import { indexOptionSentimentFade } from "./index-option-sentiment-fade.js";
import { indexOptionPcrOi } from "./index-option-pcr-oi.js";
import { indexOptionMomentumScalper } from "./index-option-momentum-scalper.js";

export * from "./contract.js";
export * from "./registry.js";
export * from "./shared.js";
export * from "./ema-crossover.js";
export * from "./rsi-reversion.js";
export * from "./orb.js";
export * from "./index-option-momentum.js";
export * from "./index-option-flow.js";
export * from "./index-option-sentiment-fade.js";
export * from "./index-option-pcr-oi.js";
export * from "./index-option-momentum-scalper.js";
export * from "./index-option-profiles.js";

/** The built-in strategy library — trend, breakout, mean reversion, and
 *  index-option flow models. */
export const BUILTIN_STRATEGIES = [
  emaCrossover,
  rsiReversion,
  orb,
  indexOptionMomentum,
  indexOptionFlowBreakout,
  indexOptionSentimentFade,
  indexOptionPcrOi,
  indexOptionMomentumScalper,
] as const;

/** Register the built-in strategy library into a registry (plan/15 §4). */
export function registerBuiltinStrategies(registry: StrategyRegistry): void {
  registry.register(emaCrossover);
  registry.register(rsiReversion);
  registry.register(orb);
  registry.register(indexOptionMomentum);
  registry.register(indexOptionFlowBreakout);
  registry.register(indexOptionSentimentFade);
  registry.register(indexOptionPcrOi);
  registry.register(indexOptionMomentumScalper);
}

/** A registry pre-loaded with the built-in strategies. */
export function createStrategyRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();
  registerBuiltinStrategies(registry);
  return registry;
}
