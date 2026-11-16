import { MIN_SAMPLE_FLOOR } from "../validation/hypothesis.js";
import {
  meanInterval,
  normalQuantile,
  sampleStdDev,
  wilsonInterval,
  type Interval,
} from "../validation/stats.js";
import type { HistoryResult } from "./history.js";
import type { ResampleResult } from "./resample.js";

/** Bumped whenever the same counts would be judged differently. */
export const ODDS_VERDICT_VERSION = "1";

/** The declared thresholds a verdict is read against (design §6.1 D5, D6). */
export interface VerdictPolicy {
  /** Points of target share from break-even before an edge is named at all. */
  marginPoints: number;
  /** Points from break-even before it is called strong. */
  strongPoints: number;
  /** Times the rule must have fired before its history is judged (Phase 7). */
  minSample: number;
  /** The confidence of the history's interval. */
  confidence: number;
}

export const DEFAULT_VERDICT_POLICY: VerdictPolicy = {
  marginPoints: 5,
  strongPoints: 15,
  minSample: MIN_SAMPLE_FLOOR,
  confidence: 0.95,
};

export type EdgeVerdict =
  | "FAVOURABLE_STRONG"
  | "FAVOURABLE"
  | "NEAR_BREAK_EVEN"
  | "UNFAVOURABLE"
  | "UNFAVOURABLE_STRONG";

export interface ResampledVerdict {
  /** Replays that reached the target or the stop. */
  decided: number;
  /** The target's share of them; null when none was decided. */
  targetShare: number | null;
  breakEven: number;
  /** Percentage points of share above break-even; negative below. */
  edgePoints: number | null;
  verdict: EdgeVerdict | "NO_DECIDED_OUTCOMES";
}

export interface HistoryVerdict {
  /** Times the rule fired on the plan's side: what the verdict is over. */
  fired: number;
  /** Of those, the ones that reached their target or their stop. */
  decided: number;
  /** The target's share of the decided ones; null when none was. */
  targetShare: number | null;
  /** Wilson interval of that share, at the policy's confidence. */
  shareInterval: Interval | null;
  /** From the rule's own targets — see `judgeHistory`. */
  breakEven: number | null;
  edgePoints: number | null;
  /** Mean R over every time it fired, however the trade ended. */
  averageR: number | null;
  /** mean ± z·sd/√n of that R, at the policy's confidence. */
  rInterval: Interval | null;
  verdict:
    "FAVOURABLE" | "UNFAVOURABLE" | "INCONCLUSIVE" | "INSUFFICIENT_SAMPLE";
}

/** The target share at which a plan paying `targetR` on a win breaks even. */
export function breakEvenShare(targetR: number): number {
  return 1 / (1 + targetR);
}

/**
 * Judge the resampled odds against the plan's break-even (design §6.1 D5).
 *
 * No interval, deliberately (D6): ten thousand replays are draws from the
 * same few hundred sessions, not ten thousand observations, and an interval
 * computed from their count would claim a certainty the pool does not hold.
 */
export function judgeResampled(
  result: ResampleResult,
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): ResampledVerdict {
  const decided = result.targetFirst + result.stopFirst;
  const breakEven = breakEvenShare(result.targetR);
  if (decided === 0)
    return {
      decided,
      targetShare: null,
      breakEven,
      edgePoints: null,
      verdict: "NO_DECIDED_OUTCOMES",
    };
  const targetShare = result.targetFirst / decided;
  const edgePoints = pointsOver(targetShare, breakEven);
  return {
    decided,
    targetShare,
    breakEven,
    edgePoints,
    verdict: grade(edgePoints, policy),
  };
}

/**
 * Judge the rule's own history (design §6.1 D6, D14).
 *
 * On the average R of EVERY time it fired, not on the target's share of the
 * decided ones. A rule may leave a trade before either level — a crossover
 * exits when the averages cross back — and then the decided trades are the
 * minority that ran far enough to be decided at all. On the stored year
 * EMA_CROSSOVER went long 357 times; 50 were decided, 56 % of them at the
 * target against a 33 % break-even, while the average of all 357 was 0.02R.
 * The share is still reported, with its interval and the rule's own
 * break-even, for what it is.
 *
 * That break-even comes from what the rule's decided trades aimed at, not
 * from the plan: a rule places its stop and target from each day's bars, so
 * its trades pay a different R from the plan's and from each other.
 *
 * Below the minimum sample there is no verdict, only the counts. Above it, a
 * direction is named only once the interval of the average R has cleared
 * zero; until then the history is INCONCLUSIVE, whatever the point estimate.
 */
export function judgeHistory(
  history: HistoryResult,
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): HistoryVerdict {
  const fired = history.outcomes.length;
  const decidedOutcomes = history.outcomes.filter(
    (o) => o.result !== "NEITHER",
  );
  const decided = decidedOutcomes.length;
  const z = normalQuantile(1 - (1 - policy.confidence) / 2);

  const targets = decidedOutcomes.filter((o) => o.result === "TARGET").length;
  const targetShare = decided === 0 ? null : targets / decided;
  const aimedAt = decidedOutcomes
    .map((o) => o.targetR)
    .filter((r): r is number => r !== null);
  const breakEven =
    aimedAt.length === 0
      ? null
      : breakEvenShare(aimedAt.reduce((sum, r) => sum + r, 0) / aimedAt.length);

  const rs = history.outcomes.map((o) => o.r);
  const averageR =
    fired === 0 ? null : rs.reduce((sum, r) => sum + r, 0) / fired;
  const rInterval =
    averageR === null
      ? null
      : meanInterval(averageR, sampleStdDev(rs), fired, z);

  return {
    fired,
    decided,
    targetShare,
    shareInterval: decided === 0 ? null : wilsonInterval(targets, decided, z),
    breakEven,
    edgePoints:
      targetShare === null || breakEven === null
        ? null
        : pointsOver(targetShare, breakEven),
    averageR,
    rInterval,
    verdict:
      rInterval === null || fired < policy.minSample
        ? "INSUFFICIENT_SAMPLE"
        : rInterval.lower > 0
          ? "FAVOURABLE"
          : rInterval.upper < 0
            ? "UNFAVOURABLE"
            : "INCONCLUSIVE",
  };
}

/** Share over break-even in percentage points, free of binary-fraction dust. */
function pointsOver(share: number, breakEven: number): number {
  return Math.round((share - breakEven) * 100 * 1e9) / 1e9;
}

function grade(edgePoints: number, policy: VerdictPolicy): EdgeVerdict {
  if (edgePoints >= policy.strongPoints) return "FAVOURABLE_STRONG";
  if (edgePoints >= policy.marginPoints) return "FAVOURABLE";
  if (edgePoints <= -policy.strongPoints) return "UNFAVOURABLE_STRONG";
  if (edgePoints <= -policy.marginPoints) return "UNFAVOURABLE";
  return "NEAR_BREAK_EVEN";
}
