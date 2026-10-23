import type { ZodType, ZodTypeDef } from "zod";
import type {
  CandleInterval,
  DerivativeTarget,
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
/**
 * What became of a signal a strategy emitted (§0.5.5).
 *
 * `FILLED` means the broker confirmed an execution. Everything else — risk
 * blocked it, the broker rejected it, the runner declined to forward it — is
 * `REJECTED`. The distinction a strategy actually needs is "did this become a
 * position?", and from that question there are only two answers.
 */
export interface SignalResolution {
  readonly signalId: string;
  readonly side: "BUY" | "SELL";
  readonly status: "FILLED" | "REJECTED";
  /** Why, in the words of whichever component decided. */
  readonly reason: string;
}

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
  /** Whether this strategy requires a live option-chain snapshot. */
  readonly requiresOptionChain?: (params: Params) => boolean;
  /** History needed before the first valid analysis (plan/15 §2). */
  warmupBars(params: Params): number;
  /**
   * The contract to trade, when it is not the symbol being analysed.
   *
   * Absent (or null) means the ordinary case: analyse X, trade X. Returning a
   * target means "I decide on this series, but place the order on a derivative
   * of this underlying" — the runner resolves the actual contract against the
   * symbol master at signal time, because the correct strike depends on spot
   * and the correct expiry depends on the date (plan/15 §4).
   */
  derivative?(params: Params): DerivativeTarget | null;
  /** Build per-symbol instance state. */
  init(params: Params, symbol: string): State;
  /** The decision function (plan/15 §2). May mutate `state`; performs no I/O. */
  analyze(context: MarketContext, state: State): StrategyVerdict;
  /**
   * Told what became of a signal this instance emitted (§0.5.5). Optional.
   *
   * It exists because `analyze()` cannot know. A one-shot strategy has to
   * mark that it proposed an entry — otherwise it proposes again on the very
   * next bar, while the first order is still in flight — but marking it as
   * TAKEN at that moment spends the day's only entry on a signal the Risk
   * Engine may be about to block. ORB lost whole days that way: blocked at
   * 09:20 by a stale market view, silent until the close.
   *
   * So a one-shot latch has three states, not two: nothing, proposed, and
   * confirmed. `analyze` moves it to proposed; this moves it to confirmed or
   * back to nothing. Synchronous and I/O-free, like `analyze`.
   */
  onSignalOutcome?(state: State, resolution: SignalResolution): void;
  /**
   * The state SHAPE's version (§0.5.6). Required alongside `snapshot`.
   *
   * Bumped whenever the stored fields change meaning. A snapshot written by an
   * older build is then REFUSED rather than misread — restoring one field into
   * another is the kind of corruption that produces plausible trades and no
   * error message.
   */
  readonly stateVersion?: string;
  /**
   * A JSON-safe picture of everything worth surviving a restart (§0.5.6).
   *
   * Strategies accumulate state across bars — an opening range, the previous
   * bar's EMAs, a one-shot latch — and a process that restarts at 11:00 built
   * none of it. ORB came back not knowing where the morning's range was; a
   * crossover came back unable to see the cross it was halfway through.
   *
   * It returns what matters, not the whole object: `params` come from stored
   * config and re-serializing them would create a second, divergent copy of
   * the operator's settings.
   *
   * Omit both this and `restore` and the strategy simply is not persisted —
   * which the runner reports rather than assumes.
   */
  snapshot?(state: State): unknown;
  /**
   * Rebuild from a snapshot this same strategy produced.
   *
   * Mutates the freshly initialised state rather than returning a new one, so
   * `init` stays the single place a state is constructed and the params it
   * holds are never overwritten by a stored copy.
   *
   * May throw on a snapshot it does not recognise; the runner treats that as
   * "start cold" and says so.
   */
  restore?(state: State, snapshot: unknown): void;
}
