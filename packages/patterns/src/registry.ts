import type { IndicatorSpec } from "@neelkanth/indicators";
import {
  toOccurrence,
  type PatternContext,
  type PatternDetector,
  type PatternOccurrence,
} from "./contract.js";

/** A detector bound to its parameters — what the registry hands back. */
export interface RunnableDetector {
  readonly patternId: string;
  readonly detectorVersion: string;
  readonly definition: string;
  requiredIndicators(): readonly IndicatorSpec[];
  warmupBars(): number;
  /** Detect on this bar's close, or null when the structure is absent. */
  detect(context: PatternContext): PatternOccurrence | null;
}

function instantiate<P>(
  detector: PatternDetector<P>,
  rawParams: unknown,
): RunnableDetector {
  // Parsed once at instantiation, not on every bar: a detector runs on every
  // candle of every backfilled day, and re-validating there would be the most
  // expensive no-op in the system.
  const params = detector.paramsSchema.parse(rawParams);
  return {
    patternId: detector.patternId,
    detectorVersion: detector.detectorVersion,
    definition: detector.definition,
    requiredIndicators: () => detector.requiredIndicators(params),
    warmupBars: () => detector.warmupBars(params),
    detect: (context) => {
      const result = detector.detect(context, params);
      return result === null
        ? null
        : toOccurrence(detector, context, params, result);
    },
  };
}

/**
 * The detector catalogue.
 *
 * Mirrors the strategy registry deliberately: same shape, same generic-capture
 * trick so stored factories are monomorphic and `any`-free. Someone who has
 * read one can read the other.
 */
export class PatternRegistry {
  private readonly factories = new Map<
    string,
    (rawParams: unknown) => RunnableDetector
  >();
  private readonly versions = new Map<string, string>();

  register<P>(detector: PatternDetector<P>): void {
    if (this.factories.has(detector.patternId)) {
      throw new Error(`pattern already registered: ${detector.patternId}`);
    }
    this.factories.set(detector.patternId, (rawParams) =>
      instantiate(detector, rawParams),
    );
    this.versions.set(detector.patternId, detector.detectorVersion);
  }

  has(patternId: string): boolean {
    return this.factories.has(patternId);
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }

  /**
   * The version each registered detector is currently at.
   *
   * A research run records this alongside its results, so a later reader can
   * tell whether two runs were produced by the same rules.
   */
  versionMap(): Record<string, string> {
    return Object.fromEntries(this.versions);
  }

  instantiate(patternId: string, rawParams: unknown = {}): RunnableDetector {
    const factory = this.factories.get(patternId);
    if (factory === undefined) {
      throw new Error(`unknown pattern: ${patternId}`);
    }
    return factory(rawParams);
  }
}
