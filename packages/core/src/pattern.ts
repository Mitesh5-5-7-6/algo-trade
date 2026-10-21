import { z } from "zod";
import { SymbolSchema, TimestampSchema } from "./primitives.js";
import { canonicalJson } from "./strategy-version.js";
import { DataProvenanceSchema, EntryMarketContextSchema } from "./trade.js";

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
const PatternOccurrenceShape = z.object({
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
  /**
   * The bar this was observed on — its key, source and ingestion version
   * (PLAN.md §10, Phase 5 D4). The candle store lets a broker bar overwrite
   * the LIVE_TICK one, so the key alone could later resolve to a bar the
   * detector never saw; the snapshot still says what it did see.
   */
  dataProvenance: DataProvenanceSchema,
  /**
   * What that bar's volume was worth (the Trade's shape). A reader pooling
   * observations must be able to tell those made on SUSPECT volume apart.
   */
  marketContext: EntryMarketContextSchema,
});

/** Provenance names a bar; it must be the bar this occurrence is about. */
function aboutItsOwnBar(
  value: z.infer<typeof PatternOccurrenceShape>,
  ctx: z.RefinementCtx,
): void {
  const at = value.dataProvenance;
  if (
    at.barTs !== value.ts ||
    at.symbol !== value.symbol ||
    at.interval !== value.interval
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dataProvenance"],
      message: "dataProvenance must name the occurrence's own bar",
    });
  }
}

export const PatternOccurrenceSchema =
  PatternOccurrenceShape.superRefine(aboutItsOwnBar);
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
export const PatternObservationSchema = PatternOccurrenceShape.extend({
  /** Derived from `params`; denormalised so the unique index can use it. */
  paramsKey: z.string().min(1).max(MAX_PARAMS_KEY),
  /** When the sweep that produced this row ran. Never the bar's time. */
  observedAt: TimestampSchema,
}).superRefine(aboutItsOwnBar);
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

/**
 * A detector definition as catalogued in `patterns` (Phase 5 D5): one per
 * `(patternId, detectorVersion)`, so an old observation can still be read
 * against the rule that produced it after the code has moved on (spec §5.1).
 */
export const PatternDefinitionSchema = z.object({
  patternId: z.string().min(1),
  detectorVersion: z.string().min(1),
  /** The rule in words — the detector's own `definition`. */
  definition: z.string().min(1),
  /** What `{}` resolves to: the parameters an unparameterised sweep uses. */
  defaultParams: z.record(z.string(), z.unknown()),
  /** Whether it declines on untrusted volume (D3). */
  volumeBased: z.boolean(),
});
export type PatternDefinition = z.infer<typeof PatternDefinitionSchema>;

/**
 * The parts of a definition that ARE the rule. Two entries for one
 * `(patternId, detectorVersion)` must agree on these, or a rule changed
 * without its version being bumped.
 */
export function definitionKey(definition: PatternDefinition): string {
  return canonicalJson({
    definition: definition.definition,
    defaultParams: definition.defaultParams,
    volumeBased: definition.volumeBased,
  });
}
