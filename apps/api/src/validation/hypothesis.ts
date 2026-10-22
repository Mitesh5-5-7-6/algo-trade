import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, RiskLimitsSchema } from "@neelkanth/core";
import { ALL } from "../counterfactual/matrix.js";
import type { CounterfactualManifest } from "../counterfactual/run.js";

/**
 * The fewest Trades the gate will ever judge (Phase 7 D5). A hypothesis may
 * ask for more, never fewer: below this a rate is an anecdote, and the
 * normal approximation the expectancy test rests on does not hold.
 */
export const MIN_SAMPLE_FLOOR = 30;

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const WindowSchema = z
  .object({ fromDate: DateSchema, toDate: DateSchema })
  .refine((w) => w.fromDate <= w.toDate, "a window ends on or after it starts");

/** The one matrix cell a hypothesis is about. */
export const HypothesisCellSchema = z.object({
  /** A pattern id, or `ALL` for the strategy's baseline. */
  patternId: z.string().min(1),
  strategyType: z.string().min(1),
  symbol: z.string().min(1),
  regime: z.enum([ALL, "BULLISH", "BEARISH", "NEUTRAL"]),
});
export type HypothesisCell = z.infer<typeof HypothesisCellSchema>;

/**
 * Everything the claim is a claim about (spec §5.3, PLAN §12 "parameter
 * versioning"). A test run whose manifest differs from these tests a
 * different claim, and is refused (D4).
 */
export const HypothesisPinsSchema = z.object({
  strategyVersion: z.string().min(1),
  /** Absent exactly when the cell is a baseline (`patternId: ALL`). */
  detectorVersion: z.string().min(1).optional(),
  positionSizing: z.string().min(1),
  exit: z.string().min(1),
  slippage: z.string().min(1),
  transactionCost: z.string().min(1),
  regime: z.record(z.string(), z.unknown()),
  attribution: z.record(z.string(), z.unknown()),
});
export type HypothesisPins = z.infer<typeof HypothesisPinsSchema>;

/** The dataset and budget the test run is made over. */
export const HypothesisRunSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1),
  indexSymbols: z.array(z.string().min(1)),
  interval: z.string().min(1),
  allocatedCapital: z.number().positive(),
  limits: RiskLimitsSchema,
  seed: z.number().int(),
  strategyParams: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
});

/**
 * A hypothesis (Phase 7 D3) — a claim, fixed before it is tested.
 *
 * Registration precedes the test, not the result (spec §5.2). Nothing here is
 * ever edited: a hypothesis revised after its result is a description.
 */
export const HypothesisSchema = z
  .object({
    hypothesisId: z.string().regex(/^H-\d{4,}$/, "hypothesis ids are H-NNNN"),
    /** The claims tested together, and corrected together (D6). */
    family: z.string().min(1),
    /** The claim in words, for the operator and the record. */
    statement: z.string().min(1),
    cell: HypothesisCellSchema,
    metric: z.enum(["winRate", "expectancy", "expectancyPerUnit"]),
    direction: z.enum(["greater", "less"]),
    threshold: z.number(),
    alpha: z.number().gt(0).max(0.2),
    minSample: z.number().int().min(MIN_SAMPLE_FLOOR),
    /** The window the claim was formed on — reported, never the verdict. */
    inSample: WindowSchema,
    /** The window it is tested on, once (D4). */
    outOfSample: WindowSchema,
    run: HypothesisRunSchema,
    pins: HypothesisPinsSchema,
    registeredAt: z.number().int().nonnegative(),
  })
  .superRefine((h, ctx) => {
    if (h.outOfSample.fromDate <= h.inSample.toDate)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outOfSample"],
        message:
          "the out-of-sample window must start after the in-sample window ends",
      });
    if (h.metric === "winRate" && (h.threshold < 0 || h.threshold > 1))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["threshold"],
        message: "a win-rate threshold is a probability, 0 to 1",
      });
    const baseline = h.cell.patternId === ALL;
    if (baseline !== (h.pins.detectorVersion === undefined))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pins", "detectorVersion"],
        message:
          "a pattern cell pins its detector version; a baseline has none",
      });
    if (h.cell.symbol !== ALL && !h.run.symbols.includes(h.cell.symbol))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cell", "symbol"],
        message: "the cell's symbol must be one the run evaluates",
      });
  });
export type Hypothesis = z.infer<typeof HypothesisSchema>;

/**
 * The definition's fingerprint: everything but when it was registered, so the
 * same claim registered twice is recognisably the same claim.
 */
export function hypothesisFingerprint(h: Hypothesis): string {
  const definition: Partial<Hypothesis> = { ...h };
  delete definition.registeredAt;
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

/** The next id after those already registered: H-0001, H-0002, … */
export function nextHypothesisId(existing: readonly string[]): string {
  const max = existing.reduce((m, id) => {
    const n = /^H-(\d+)$/.exec(id)?.[1];
    return n === undefined ? m : Math.max(m, Number(n));
  }, 0);
  return `H-${String(max + 1).padStart(4, "0")}`;
}

/**
 * The pins a cell's claim carries, read off the run it was formed on — so
 * registering from an in-sample run fixes the versions it will be tested
 * under. Refuses a cell whose strategy ran at two versions (two symbols,
 * two configurations): that is two claims, not one.
 */
export function pinsFor(
  manifest: CounterfactualManifest,
  cell: HypothesisCell,
): HypothesisPins {
  const versions = new Set(
    manifest.strategies
      .filter(
        (s) =>
          s.eligible &&
          s.type === cell.strategyType &&
          (cell.symbol === ALL || s.symbol === cell.symbol),
      )
      .map((s) => (s.eligible ? s.strategyVersion : "")),
  );
  const [strategyVersion] = versions;
  if (versions.size !== 1 || strategyVersion === undefined)
    throw new Error(
      `${cell.strategyType} on ${cell.symbol} ran at ${String(versions.size)} versions in this run; a hypothesis pins exactly one`,
    );
  const detector = manifest.detectors.find(
    (d) => d.definition.patternId === cell.patternId,
  );
  if (cell.patternId !== ALL && detector === undefined)
    throw new Error(`the run swept no ${cell.patternId} detector`);
  return {
    strategyVersion,
    ...(detector === undefined
      ? {}
      : { detectorVersion: detector.definition.detectorVersion }),
    positionSizing: manifest.models.positionSizing,
    exit: manifest.models.exit,
    slippage: manifest.models.slippage.version,
    transactionCost: manifest.models.transactionCost.version,
    regime: manifest.models.regime as unknown as Record<string, unknown>,
    attribution: manifest.models.attribution as unknown as Record<
      string,
      unknown
    >,
  };
}
