import { z } from "zod";
import { ALL } from "../counterfactual/matrix.js";
import { GATE_POLICY_VERSION, type HypothesisTest } from "./gate.js";
import {
  HypothesisCellSchema,
  hypothesisFingerprint,
  HypothesisSchema,
  type Hypothesis,
} from "./hypothesis.js";
import { holmAdjust } from "./stats.js";

/**
 * A finding (Phase 7 D7): everything spec §5.2 and PLAN §12 say must travel
 * with a result. Every field required — a rate without its sample size,
 * period, regime, costs, slippage, versions and out-of-sample status is
 * exactly the "78% win rate" this phase exists to prevent.
 */
export const FindingSchema = z.object({
  hypothesisId: z.string().min(1),
  family: z.string().min(1),
  familySize: z.number().int().positive(),
  statement: z.string().min(1),
  cell: HypothesisCellSchema,
  metric: z.enum(["winRate", "expectancy", "expectancyPerUnit"]),
  direction: z.enum(["greater", "less"]),
  threshold: z.number(),
  alpha: z.number(),
  sampleSize: z.number().int().nonnegative(),
  minSample: z.number().int().positive(),
  dateRange: z.object({
    fromDate: z.string().min(1),
    toDate: z.string().min(1),
  }),
  instrumentCount: z.number().int().positive(),
  regime: z.string().min(1),
  /** True: the verdict comes from data the claim was not formed on. */
  outOfSample: z.literal(true),
  estimate: z.number().nullable(),
  interval: z.object({ lower: z.number(), upper: z.number() }).nullable(),
  pValue: z.number().nullable(),
  /** Holm-adjusted across the whole family. */
  adjustedPValue: z.number().nullable(),
  /** The gate's verdict on this claim alone. */
  rawVerdict: z.enum([
    "SUPPORTED",
    "NOT_SUPPORTED",
    "INSUFFICIENT_SAMPLE",
    "UNTESTED",
  ]),
  /** After the family correction — the only verdict a finding may claim. */
  verdict: z.enum([
    "SUPPORTED",
    "NOT_SUPPORTED",
    "INSUFFICIENT_SAMPLE",
    "UNTESTED",
  ]),
  costs: z.object({
    charges: z.number(),
    slippage: z.number(),
    net: z.number(),
  }),
  inSample: z
    .object({
      n: z.number().int().nonnegative(),
      estimate: z.number().nullable(),
      verdict: z.string().min(1),
    })
    .nullable(),
  versions: z.object({
    strategy: z.string().min(1),
    detector: z.string().min(1),
    positionSizing: z.string().min(1),
    exit: z.string().min(1),
    slippage: z.string().min(1),
    transactionCost: z.string().min(1),
    gatePolicy: z.string().min(1),
  }),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * A family's findings, corrected together (Phase 7 D6).
 *
 * Holm across every REGISTERED member, not only the tested ones: a member
 * never tested, or tested on too few Trades, enters the correction at p = 1.
 * Otherwise registering ten claims and testing the promising three would
 * buy a smaller correction — the selection the registry exists to stop.
 * Members must share one alpha; a test must match its hypothesis exactly —
 * a claim edited after its test is refused.
 */
export function familyFindings(
  hypotheses: readonly Hypothesis[],
  tests: readonly HypothesisTest[],
): Finding[] {
  const parsed = hypotheses.map((h) => HypothesisSchema.parse(h));
  const [first] = parsed;
  if (first === undefined) return [];
  for (const h of parsed) {
    if (h.family !== first.family)
      throw new Error(
        `${h.hypothesisId} is in family ${h.family}, not ${first.family}`,
      );
    if (h.alpha !== first.alpha)
      throw new Error(
        `family ${first.family} mixes alphas (${String(first.alpha)}, ${String(h.alpha)}); a family is judged at one`,
      );
  }
  const byId = new Map(parsed.map((h) => [h.hypothesisId, h]));
  const testOf = new Map<string, HypothesisTest>();
  for (const t of tests) {
    const h = byId.get(t.hypothesisId);
    if (h === undefined)
      throw new Error(
        `test of ${t.hypothesisId}, which family ${first.family} does not hold`,
      );
    if (t.hypothesisFingerprint !== hypothesisFingerprint(h))
      throw new Error(`${t.hypothesisId} was edited after it was tested`);
    if (testOf.has(t.hypothesisId))
      throw new Error(
        `${t.hypothesisId} was tested twice; a hypothesis is tested once`,
      );
    testOf.set(t.hypothesisId, t);
  }

  const raw = parsed.map(
    (h) => testOf.get(h.hypothesisId)?.outOfSample.pValue ?? 1,
  );
  const adjusted = holmAdjust(raw);
  return parsed.map((h, i) => {
    const t = testOf.get(h.hypothesisId);
    const oos = t?.outOfSample;
    const rawVerdict = oos?.verdict ?? "UNTESTED";
    const adj =
      oos?.pValue === null || oos === undefined ? null : (adjusted[i] ?? 1);
    const verdict =
      rawVerdict === "UNTESTED" || rawVerdict === "INSUFFICIENT_SAMPLE"
        ? rawVerdict
        : adj !== null && adj < h.alpha
          ? "SUPPORTED"
          : "NOT_SUPPORTED";
    return FindingSchema.parse({
      hypothesisId: h.hypothesisId,
      family: h.family,
      familySize: parsed.length,
      statement: h.statement,
      cell: h.cell,
      metric: h.metric,
      direction: h.direction,
      threshold: h.threshold,
      alpha: h.alpha,
      sampleSize: oos?.n ?? 0,
      minSample: h.minSample,
      dateRange: oos?.dateRange ?? h.outOfSample,
      instrumentCount: h.cell.symbol === ALL ? h.run.symbols.length : 1,
      regime: h.cell.regime,
      outOfSample: true,
      estimate: oos?.estimate ?? null,
      interval: oos?.interval ?? null,
      pValue: oos?.pValue ?? null,
      adjustedPValue: adj,
      rawVerdict,
      verdict,
      costs: {
        charges: oos?.charges ?? 0,
        slippage: oos?.slippage ?? 0,
        net: oos?.net ?? 0,
      },
      inSample:
        t === undefined
          ? null
          : {
              n: t.inSample.n,
              estimate: t.inSample.estimate,
              verdict: t.inSample.verdict,
            },
      versions: {
        strategy: h.pins.strategyVersion,
        detector: h.pins.detectorVersion ?? "none (baseline)",
        positionSizing: h.pins.positionSizing,
        exit: h.pins.exit,
        slippage: h.pins.slippage,
        transactionCost: h.pins.transactionCost,
        gatePolicy: t?.gatePolicyVersion ?? GATE_POLICY_VERSION,
      },
    });
  });
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const num = (x: number): string => x.toFixed(2);

/**
 * The one way a finding becomes words (D7). It parses first, so a finding
 * missing any of its context cannot be said at all — and every sentence it
 * produces carries n, period, regime, costs, slippage, versions and
 * out-of-sample status beside the number.
 */
export function describeFinding(raw: Finding): string {
  const f = FindingSchema.parse(raw);
  const fmt = f.metric === "winRate" ? pct : num;
  const label =
    f.metric === "winRate"
      ? "win rate"
      : f.metric === "expectancy"
        ? "expectancy per Trade"
        : "expectancy per unit";
  const subject = `${f.cell.strategyType} on ${f.cell.patternId === ALL ? "every Trade" : f.cell.patternId}, ${f.cell.symbol === ALL ? `${String(f.instrumentCount)} instruments` : f.cell.symbol}, regime ${f.regime}`;
  const claim = `claim: ${label} ${f.direction === "greater" ? ">" : "<"} ${fmt(f.threshold)}`;
  const period = `out of sample ${f.dateRange.fromDate} .. ${f.dateRange.toDate}`;
  const measured =
    f.estimate === null
      ? "no Trades"
      : `${label} ${fmt(f.estimate)}${f.interval === null ? "" : ` (interval ${fmt(f.interval.lower)} .. ${fmt(f.interval.upper)})`}`;
  const evidence =
    f.verdict === "UNTESTED"
      ? "not tested"
      : f.verdict === "INSUFFICIENT_SAMPLE"
        ? `n = ${String(f.sampleSize)} < ${String(f.minSample)} — not judged`
        : `n = ${String(f.sampleSize)}; p = ${(f.pValue ?? 1).toPrecision(3)}, Holm-adjusted ${(f.adjustedPValue ?? 1).toPrecision(3)} in a family of ${String(f.familySize)} at α ${String(f.alpha)}`;
  const insample =
    f.inSample === null
      ? ""
      : `; in sample: n = ${String(f.inSample.n)}, ${f.inSample.estimate === null ? "no Trades" : fmt(f.inSample.estimate)} (${f.inSample.verdict})`;
  const costs = `charges ${num(f.costs.charges)}, slippage ${num(f.costs.slippage)}, net ${num(f.costs.net)}`;
  const v = f.versions;
  const versions = `strategy ${v.strategy}, detector ${v.detector}, sizing ${v.positionSizing}, exit ${v.exit}, slippage ${v.slippage}, cost ${v.transactionCost}, gate ${v.gatePolicy}`;
  return `${f.hypothesisId} [${f.family}] ${f.verdict} — ${subject}; ${claim}; ${period}: ${measured}; ${evidence}${insample}. Costs: ${costs}. Versions: ${versions}.`;
}
