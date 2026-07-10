import type { ZodType, ZodTypeDef } from "zod";
import type {
  CandleInterval,
  MarketContext,
  StrategyVerdict,
} from "@neelkanth/core";
import type { IndicatorSpec } from "@neelkanth/indicators";

/**
 * The Strategy contract (plan/15 §2). Every strategy in the library implements
 * this one interface. The division of labor that keeps strategies simple: a
 * strategy is a pure decision function; the engine owns everything else —
 * scheduling, data assembly, lifecycle, exits, the handoff to risk.
 *
 * - `analyze()` is **pure and synchronous**: context in, verdict out, no I/O.
 *   This is what makes a strategy deterministic (plan/02 Principle 1),
 *   unit-testable with a fabricated context, and safe on the hot path. It may
 *   evolve its own per-instance `state` (e.g. tracking the previous bar's EMAs
 *   to detect a cross) — that internal mutation is the only side effect
 *   allowed; it performs no I/O and touches nothing external.
 * - `requiredIndicators()` is **declarative** so the engine, not the strategy,
 *   arranges for the right indicators to exist (plan/18 §2).
 * - `warmupBars()` exists because indicators (and state) lie when young
 *   (plan/15 §2, plan/18 §4).
 * - `paramsSchema` validates operator config at enable time (plan/15 §4).
 */
export interface StrategyDefinition<Params, State> {
  /** Registry key mapping stored config → code (plan/15 §4), e.g. "EMA_CROSSOVER". */
  readonly type: string;
  /**
   * Zod schema validating `strategies.params` at enable time (plan/15 §4). The
   * input type is `unknown` (the runner parses raw operator config) while the
   * output is the fully-defaulted `Params` — which is why `.default()`/`.refine()`
   * schemas fit here where `ZodType<Params>` (input = output) would not.
   */
  readonly paramsSchema: ZodType<Params, ZodTypeDef, unknown>;
  /** The candle interval this strategy decides on. */
  interval(params: Params): CandleInterval;
  /** The indicators the context must contain (plan/15 §2). */
  requiredIndicators(params: Params): readonly IndicatorSpec[];
  /** History needed before the first valid analysis (plan/15 §2). */
  warmupBars(params: Params): number;
  /** Build per-symbol instance state. */
  init(params: Params, symbol: string): State;
  /** The decision function (plan/15 §2). May mutate `state`; performs no I/O. */
  analyze(context: MarketContext, state: State): StrategyVerdict;
}
