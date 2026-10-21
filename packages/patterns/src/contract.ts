/**
 * A pattern is an observation about market structure, **not a trade decision**.
 *
 * That distinction is the whole point of the pattern × strategy matrix. The
 * research question is "when pattern P occurred, how did strategy S do?" — and
 * it is only answerable if P is defined independently of every S. So a detector
 * carries no stop, no target, no quantity and no opinion about whether to
 * trade: it says "this structure completed here, in this direction", and
 * nothing more.
 *
 * A strategy may happen to look for the same structure. That is fine, and it is
 * precisely what makes the matrix interesting: the detector is the impartial
 * observer both strategies are scored against.
 */
import type { ZodType, ZodTypeDef } from "zod";
import {
  PatternOccurrenceSchema,
  type Candle,
  type CandleInterval,
  type PatternDirection,
  type PatternOccurrence,
} from "@neelkanth/core";
import type { IndicatorSpec } from "@neelkanth/indicators";

/**
 * The stored record lives in `@neelkanth/core` beside `Trade` and `Candle`,
 * because the repository that writes it and the research that reads it must
 * agree on its shape without either depending on the detector library. It is
 * re-exported here so a caller working with detectors has one import.
 */
export {
  PatternDirectionSchema,
  PatternOccurrenceSchema,
  type PatternDirection,
  type PatternOccurrence,
} from "@neelkanth/core";

/**
 * What a detector may look at.
 *
 * `candles` ends at the decision bar — the last element IS `candle`. A detector
 * therefore cannot see the future, structurally rather than by convention
 * (§5.4: `Feature(t) = f(candles ≤ t)`). Indicators are supplied already
 * computed for that same bar.
 */
export interface PatternContext {
  readonly symbol: string;
  readonly interval: CandleInterval;
  /** The bar being judged — always the last element of `candles`. */
  readonly candle: Candle;
  /** Oldest → newest, ending at `candle`. Never contains a later bar. */
  readonly candles: readonly Candle[];
  readonly indicators: Readonly<Record<string, number>>;
  /**
   * The same indicators at the PREVIOUS bar's close. Empty on the first bar.
   *
   * Supplied rather than remembered. A cross is an event — a relationship that
   * inverted — so a detector needs two points to see one. Keeping that second
   * point as internal state would make a detector's answer depend on where a
   * replay started, which is exactly the determinism Phase 4 must establish.
   */
  readonly previousIndicators: Readonly<Record<string, number>>;
  /** Minutes since the session opened, for session-anchored structures. */
  readonly minutesSinceOpen: number;
  /** Epoch ms of this session's open, so a detector can find its own day. */
  readonly sessionOpenTs: number;
}

/**
 * A pattern detector (§5.1).
 *
 * Deterministic and pure: the same context and parameters must always produce
 * the same answer, because replay compares runs and a detector that drifts
 * makes every comparison meaningless.
 */
export interface PatternDetector<Params> {
  /** Stable identifier, e.g. `ORB_BREAKOUT`. Never reused for another rule. */
  readonly patternId: string;
  /**
   * Bumped whenever the RULE changes — not when the code is merely tidied.
   *
   * Occurrences carry it, so research can ask "under which definition?" and
   * refuse to pool detections from two different rules.
   */
  readonly detectorVersion: string;
  /** The rule in words, for the operator and for the research record. */
  readonly definition: string;
  readonly paramsSchema: ZodType<Params, ZodTypeDef, unknown>;
  /** Indicators the context must carry before `detect` is called. */
  requiredIndicators(params: Params): readonly IndicatorSpec[];
  /** Bars needed before the first valid detection. */
  warmupBars(params: Params): number;
  /**
   * The bars whose VOLUME this detector's answer rests on, for a volume-based
   * detector; absent for one that reads only price (Phase 5 D3).
   *
   * The registry refuses to judge when any of them has untrusted volume
   * (`hasTrustedVolume`), so the check lives in one place and cannot be
   * forgotten by a detector — a detector only has to say what it reads.
   */
  volumeBars?(context: PatternContext, params: Params): readonly Candle[];
  /**
   * Judge the close of `context.candle`.
   *
   * Returns null when the structure is absent — which is the ordinary case and
   * is not an error. Never throws on missing indicators; a detector that
   * cannot yet see enough returns null.
   */
  detect(context: PatternContext, params: Params): DetectionResult | null;
}

/** What a detector returns; the registry adds identity and provenance. */
export interface DetectionResult {
  direction: PatternDirection;
  evidence: Record<string, number>;
}

/** Build the stored occurrence from a detection. */
export function toOccurrence<Params>(
  detector: PatternDetector<Params>,
  context: PatternContext,
  params: Params,
  result: DetectionResult,
): PatternOccurrence {
  return PatternOccurrenceSchema.parse({
    patternId: detector.patternId,
    detectorVersion: detector.detectorVersion,
    symbol: context.symbol,
    interval: context.interval,
    ts: context.candle.ts,
    direction: result.direction,
    evidence: result.evidence,
    params: params as Record<string, unknown>,
  });
}
