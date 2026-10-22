import { hasTrustedVolume, type PatternDefinition } from "@neelkanth/core";
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
  /** The parameters it runs at, resolved — defaults filled in. */
  readonly params: Record<string, unknown>;
  requiredIndicators(): readonly IndicatorSpec[];
  warmupBars(): number;
  /** Whether this detector reads volume at all (Phase 5 D3). */
  readonly volumeBased: boolean;
  /**
   * Whether the volume this bar's answer would rest on can be trusted. Always
   * true for a price-only detector. A caller counts the falses, so "declined
   * for volume" is reported rather than read as "found nothing".
   */
  volumeTrusted(context: PatternContext): boolean;
  /**
   * Detect on this bar's close, or null when the structure is absent — or
   * when its volume cannot be trusted, which no caller can bypass.
   */
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
  const volumeTrusted = (context: PatternContext): boolean =>
    detector.volumeBars === undefined ||
    detector.volumeBars(context, params).every(hasTrustedVolume);
  return {
    patternId: detector.patternId,
    detectorVersion: detector.detectorVersion,
    definition: detector.definition,
    params: params as Record<string, unknown>,
    requiredIndicators: () => detector.requiredIndicators(params),
    warmupBars: () => detector.warmupBars(params),
    volumeBased: detector.volumeBars !== undefined,
    volumeTrusted,
    detect: (context) => {
      if (!volumeTrusted(context)) return null;
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
  private readonly definitions = new Map<string, PatternDefinition>();

  register<P>(detector: PatternDetector<P>): void {
    if (this.factories.has(detector.patternId)) {
      throw new Error(`pattern already registered: ${detector.patternId}`);
    }
    this.factories.set(detector.patternId, (rawParams) =>
      instantiate(detector, rawParams),
    );
    this.versions.set(detector.patternId, detector.detectorVersion);
    this.definitions.set(detector.patternId, {
      patternId: detector.patternId,
      detectorVersion: detector.detectorVersion,
      definition: detector.definition,
      defaultParams: detector.paramsSchema.parse({}) as Record<string, unknown>,
      volumeBased: detector.volumeBars !== undefined,
    });
  }

  /**
   * Every registered detector's definition, for the `patterns` catalogue
   * (Phase 5 D5). A sweep records these before the observations they label.
   */
  catalog(): PatternDefinition[] {
    return [...this.definitions.values()];
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
