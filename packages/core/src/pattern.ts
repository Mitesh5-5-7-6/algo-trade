import { z } from "zod";
import { SymbolSchema, TimestampSchema } from "./primitives.js";
import { canonicalJson } from "./strategy-version.js";

/**
 * Chart patterns as stored evidence (RND_RESEARCH_SPECIFICATION §5).
 *
 * The detector library (`@neelkanth/patterns`) decides what a pattern IS. This
 * module owns what a detection is once written down, because the repository
 * that stores it and the research that reads it must agree on the record
 * without either depending on the detector implementations.
 */

/** Which way the structure resolved. */
export const PatternDirectionSchema = z.enum(["BULLISH", "BEARISH"]);
export type PatternDirection = z.infer<typeof PatternDirectionSchema>;

/**
 * One detection.
 *
 * `evidence` carries the numbers that triggered it. Without them a stored
 * detection is an assertion nobody can re-check — and re-checking is the only
 * way to tell a real edge from a detector bug six months later.
 */
export const PatternOccurrenceSchema = z.object({
  patternId: z.string().min(1),
  /**
   * The detector build that produced this.
   *
   * Recorded on every occurrence, not just in the registry, so a redefinition
   * of "ORB breakout" in six months cannot silently restate what earlier
   * research concluded (§5.1).
   */
  detectorVersion: z.string().min(1),
  symbol: SymbolSchema,
  interval: z.string().min(1),
  /** The bar on whose CLOSE the pattern completed. */
  ts: TimestampSchema,
  direction: PatternDirectionSchema,
  /** Detector-specific numbers that produced the detection. */
  evidence: z.record(z.string(), z.number()),
  /** The parameters in force, so a detection is reproducible from its record. */
  params: z.record(z.string(), z.unknown()),
});
export type PatternOccurrence = z.infer<typeof PatternOccurrenceSchema>;

/**
 * Mongo refuses an index entry over 1024 bytes, and `paramsKey` is part of a
 * compound index. Detector parameters are a handful of numbers, so a key this
 * long means something is wrong with the caller — better a loud parse failure
 * here than an opaque write rejection at the database.
 */
const MAX_PARAMS_KEY = 512;

/**
 * A deterministic string identifying one parameter set.
 *
 * Keys sorted, so `{fast: 9, slow: 21}` and `{slow: 21, fast: 9}` are the same
 * configuration and not two. `JSON.stringify` alone would not give that — it
 * preserves insertion order, which depends on how the object happened to be
 * built.
 *
 * It is `canonicalJson` — the same serialisation a strategy version and a
 * replay fingerprint use — so "the same parameters" means one thing across the
 * system.
 *
 * The canonical string IS the key; it is not hashed. Parameter sets are tiny,
 * and a readable key cannot collide, while a short digest can — silently
 * merging two different configurations into one sample.
 */
export function patternParamsKey(params: Record<string, unknown>): string {
  const key = canonicalJson(params);
  if (key.length > MAX_PARAMS_KEY) {
    throw new Error(
      `pattern params key too long (${String(key.length)} > ${String(MAX_PARAMS_KEY)})`,
    );
  }
  return key;
}

/**
 * A detection as it is stored (`pattern_observations`).
 *
 * Identity is `(patternId, detectorVersion, paramsKey, symbol, interval, ts)`.
 * All six matter:
 *
 * - **Without `ts`, `symbol`, `interval`** two different bars would collide.
 * - **Without `detectorVersion`** a redefined detector would overwrite the
 *   evidence earlier research was built on, and the version would become a
 *   label with nothing behind it.
 * - **Without `paramsKey`** a sweep over five parameter sets would store the
 *   last one and discard four, which is precisely the comparison Phase 12
 *   exists to make.
 *
 * Note this is the OPPOSITE of the candle rule, deliberately. Candles converge
 * on one canonical bar because there is one truth about what the market did.
 * Observations do not converge, because there is no single truth about "was
 * this an ORB breakout" — only "under this definition, at these parameters,
 * yes". Two rows for one bar is the correct answer, not a duplicate.
 */
export const PatternObservationSchema = PatternOccurrenceSchema.extend({
  /** Derived from `params`; denormalised so the unique index can use it. */
  paramsKey: z.string().min(1).max(MAX_PARAMS_KEY),
  /** When the sweep that produced this row ran. Never the bar's time. */
  observedAt: TimestampSchema,
});
export type PatternObservation = z.infer<typeof PatternObservationSchema>;

/** Complete an occurrence into its stored form. */
export function toObservation(
  occurrence: PatternOccurrence,
  observedAt: number,
): PatternObservation {
  return PatternObservationSchema.parse({
    ...occurrence,
    paramsKey: patternParamsKey(occurrence.params),
    observedAt,
  });
}
