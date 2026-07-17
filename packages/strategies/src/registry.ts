import type {
  CandleInterval,
  MarketContext,
  StrategyVerdict,
} from "@neelkanth/core";
import type { IndicatorSpec } from "@neelkanth/indicators";
import type { StrategyDefinition } from "./contract.js";

/**
 * A strategy instance with its generic Params/State boxed away, so the runner
 * can hold heterogeneous strategies in one collection without `any`. `analyze`
 * closes over this instance's own state (plan/15 §7: one instance per
 * (strategy, symbol), state private).
 */
export interface RunnableStrategy {
  readonly type: string;
  readonly interval: CandleInterval;
  requiredIndicators(): readonly IndicatorSpec[];
  warmupBars(): number;
  analyze(context: MarketContext): StrategyVerdict;
}

function instantiate<P, S>(
  def: StrategyDefinition<P, S>,
  rawParams: unknown,
  symbol: string,
): RunnableStrategy {
  // Validate operator config at the boundary (plan/15 §4, plan/04 §4).
  const params = def.paramsSchema.parse(rawParams);
  const state = def.init(params, symbol);
  return {
    type: def.type,
    interval: def.interval(params),
    requiredIndicators: () => def.requiredIndicators(params),
    warmupBars: () => def.warmupBars(params),
    analyze: (context) => def.analyze(context, state),
  };
}

/**
 * The strategy registry (plan/15 §4): maps a stored `type` string to code. The
 * operator's config is data; the registry is what turns data into a running
 * strategy, so adding a strategy to the library is one registration — and an
 * unknown type fails loudly at enable time, not mysteriously at runtime.
 */
export class StrategyRegistry {
  private readonly factories = new Map<
    string,
    (rawParams: unknown, symbol: string) => RunnableStrategy
  >();

  /** Register a strategy definition. `register<P,S>` captures the generics in
   *  the closure, so the stored factory is monomorphic and `any`-free. */
  register<P, S>(def: StrategyDefinition<P, S>): void {
    if (this.factories.has(def.type)) {
      throw new Error(`strategy type already registered: ${def.type}`);
    }
    this.factories.set(def.type, (rawParams, symbol) =>
      instantiate(def, rawParams, symbol),
    );
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  /** The registered type names — the control plane's create-form catalog. */
  types(): string[] {
    return [...this.factories.keys()];
  }

  /** Instantiate a per-symbol strategy instance; throws on an unknown type. */
  instantiate(
    type: string,
    rawParams: unknown,
    symbol: string,
  ): RunnableStrategy {
    const factory = this.factories.get(type);
    if (factory === undefined) {
      throw new Error(`unknown strategy type: ${type}`);
    }
    return factory(rawParams, symbol);
  }
}
