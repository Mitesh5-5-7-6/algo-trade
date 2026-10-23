import { canonicalJson } from "@neelkanth/core";
import type { MatrixRow, TradeStats } from "../counterfactual/matrix.js";
import { ALL } from "../counterfactual/matrix.js";
import type { CounterfactualRun } from "../counterfactual/run.js";
import {
  hypothesisFingerprint,
  HypothesisSchema,
  pinsFor,
  type Hypothesis,
} from "./hypothesis.js";
import {
  binomialLowerTail,
  binomialUpperTail,
  meanInterval,
  meanPValue,
  normalQuantile,
  wilsonInterval,
  type Interval,
} from "./stats.js";

/**
 * Bumped whenever how the gate judges a claim changes (Phase 7 D5). 2: a
 * "less" win-rate claim's p-value is the lower tail computed directly, not
 * 1 − an upper tail, which cancelled to 0 below ~1e-16 (found by 7.7).
 */
export const GATE_POLICY_VERSION = "2";

export type Verdict = "SUPPORTED" | "NOT_SUPPORTED" | "INSUFFICIENT_SAMPLE";

/** One window's judgement of a claim. */
export interface WindowEvaluation {
  /** The days the run actually held, first to last. */
  dateRange: { fromDate: string; toDate: string };
  n: number;
  /** The metric's value in the window; null without Trades. */
  estimate: number | null;
  /**
   * Two-sided at 1 − 2α, so its relevant side is the one-sided bound at 1 − α
   * — the test's own level. Null below the minimum sample.
   */
  interval: Interval | null;
  /** One-sided, in the claim's direction; null below the minimum sample. */
  pValue: number | null;
  verdict: Verdict;
  charges: number;
  slippage: number;
  net: number;
  /** The run this window was judged on. */
  runFingerprint: string;
}

/** A hypothesis tested once, out of sample (Phase 7 D4). */
export interface HypothesisTest {
  hypothesisId: string;
  hypothesisFingerprint: string;
  family: string;
  testedAt: number;
  gatePolicyVersion: string;
  /** The verdict. */
  outOfSample: WindowEvaluation;
  /** What the claim was formed on — reported, never the verdict. */
  inSample: WindowEvaluation;
}

/**
 * Test a hypothesis once (Phase 7 D4, D5).
 *
 * Refused — thrown, never judged — when the test does not come after the
 * registration, when a run's days fall outside the window it stands for, or
 * when a run was measured under versions other than those the claim pins:
 * each would be a test of some other claim. The out-of-sample window gives
 * the verdict; the in-sample one is judged identically and reported beside
 * it, so the drop from one to the other is visible.
 */
export function testHypothesis(
  raw: Hypothesis,
  inSampleRun: CounterfactualRun,
  outOfSampleRun: CounterfactualRun,
  testedAt: number,
): HypothesisTest {
  const h = HypothesisSchema.parse(raw);
  if (testedAt <= h.registeredAt)
    throw new Error(
      `${h.hypothesisId}: a test must come after its registration (spec §5.2)`,
    );
  checkRun(h, inSampleRun, "in-sample");
  checkRun(h, outOfSampleRun, "out-of-sample");
  return {
    hypothesisId: h.hypothesisId,
    hypothesisFingerprint: hypothesisFingerprint(h),
    family: h.family,
    testedAt,
    gatePolicyVersion: GATE_POLICY_VERSION,
    outOfSample: judge(h, outOfSampleRun),
    inSample: judge(h, inSampleRun),
  };
}

function checkRun(
  h: Hypothesis,
  run: CounterfactualRun,
  which: "in-sample" | "out-of-sample",
): void {
  const window = which === "in-sample" ? h.inSample : h.outOfSample;
  const days = run.manifest.dataset.days;
  const first = days[0];
  const last = days.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    first < window.fromDate ||
    last > window.toDate
  )
    throw new Error(
      `${h.hypothesisId}: the ${which} run holds ${first ?? "-"} .. ${last ?? "-"}, outside its window ${window.fromDate} .. ${window.toDate}`,
    );
  const pins = pinsFor(run.manifest, h.cell);
  for (const key of Object.keys(h.pins) as (keyof Hypothesis["pins"])[]) {
    if (canonicalJson(pins[key]) !== canonicalJson(h.pins[key]))
      throw new Error(
        `${h.hypothesisId}: the ${which} run was measured with ${key} ${canonicalJson(pins[key])}, but the claim pins ${canonicalJson(h.pins[key])}`,
      );
  }
}

const EMPTY: TradeStats = {
  n: 0,
  wins: 0,
  losses: 0,
  winRate: null,
  gross: 0,
  charges: 0,
  slippage: 0,
  net: 0,
  expectancy: null,
  expectancyPerUnit: null,
  netStdDev: null,
  perUnitStdDev: null,
  maxDrawdown: 0,
  meanHoldMinutes: null,
  exits: {},
};

/** A cell absent from the matrix had no Trades in it: n = 0, not an error. */
function cellOf(h: Hypothesis, matrix: readonly MatrixRow[]): TradeStats {
  const row = matrix.find(
    (r) =>
      r.patternId === h.cell.patternId &&
      r.strategyType === h.cell.strategyType &&
      r.symbol === h.cell.symbol &&
      r.regime === h.cell.regime &&
      (h.cell.patternId === ALL ||
        r.detectorVersion === h.pins.detectorVersion),
  );
  return row?.trades ?? EMPTY;
}

function judge(h: Hypothesis, run: CounterfactualRun): WindowEvaluation {
  const stats = cellOf(h, run.matrix);
  const days = run.manifest.dataset.days;
  const base = {
    dateRange: { fromDate: days[0] ?? "", toDate: days.at(-1) ?? "" },
    n: stats.n,
    charges: stats.charges,
    slippage: stats.slippage,
    net: stats.net,
    runFingerprint: run.fingerprint,
  };
  const estimate =
    h.metric === "winRate"
      ? stats.winRate
      : h.metric === "expectancy"
        ? stats.expectancy
        : stats.expectancyPerUnit;
  // The gate's first rule: below the minimum, no verdict on the rate at all.
  if (stats.n < h.minSample)
    return {
      ...base,
      estimate,
      interval: null,
      pValue: null,
      verdict: "INSUFFICIENT_SAMPLE",
    };

  const z = normalQuantile(1 - h.alpha);
  let interval: Interval;
  let pValue: number;
  if (h.metric === "winRate") {
    interval = wilsonInterval(stats.wins, stats.n, z);
    pValue =
      h.direction === "greater"
        ? binomialUpperTail(stats.wins, stats.n, h.threshold)
        : binomialLowerTail(stats.wins, stats.n, h.threshold);
  } else {
    const mean = estimate ?? 0;
    const sd =
      (h.metric === "expectancy" ? stats.netStdDev : stats.perUnitStdDev) ?? 0;
    interval = meanInterval(mean, sd, stats.n, z);
    pValue = meanPValue(mean, sd, stats.n, h.threshold, h.direction);
  }
  return {
    ...base,
    estimate,
    interval,
    pValue,
    verdict: pValue < h.alpha ? "SUPPORTED" : "NOT_SUPPORTED",
  };
}
