import { describe, expect, it } from "vitest";
import type { HistoryOutcome, HistoryResult } from "./history.js";
import type { ResampleResult } from "./resample.js";
import {
  breakEvenShare,
  DEFAULT_VERDICT_POLICY,
  judgeHistory,
  judgeResampled,
} from "./verdict.js";

/** A resampling result with only what the verdict reads. */
function resampled(
  targetFirst: number,
  stopFirst: number,
  targetR: number,
  replays = 1000,
): ResampleResult {
  return {
    replays,
    seed: 0,
    window: 0,
    targetR,
    targetFirst,
    stopFirst,
    neither: replays - targetFirst - stopFirst,
    gapThroughStop: 0,
    averageR: 0,
    closeBands: { p5: 0, p25: 0, p50: 0, p75: 0, p95: 0 },
  };
}

/**
 * A history of `targets` wins and `stops` losses, every trade aiming at
 * `targetR`, and `neither` trades the rule left early at `neitherR`.
 */
function history(
  targets: number,
  stops: number,
  targetR: number,
  neither = 0,
  neitherR = 0,
): HistoryResult {
  const outcome = (result: HistoryOutcome["result"], i: number) => ({
    date: "2026-03-02",
    entryTime: i,
    result,
    targetR,
    r: result === "TARGET" ? targetR : result === "STOP" ? -1 : neitherR,
    exitReason: result,
  });
  const outcomes = [
    ...Array.from({ length: targets }, (_, i) => outcome("TARGET", i)),
    ...Array.from({ length: stops }, (_, i) => outcome("STOP", targets + i)),
    ...Array.from({ length: neither }, (_, i) =>
      outcome("NEITHER", targets + stops + i),
    ),
  ];
  return {
    sessions: 200,
    fired: outcomes.length,
    targetFirst: targets,
    stopFirst: stops,
    neither,
    otherSide: 0,
    averageR: 0,
    outcomes,
    replayFingerprint: "f".repeat(64),
  };
}

describe("the setup-odds verdict (17.5)", () => {
  it("puts break-even at 1 / (1 + R)", () => {
    expect(breakEvenShare(1)).toBe(0.5);
    expect(breakEvenShare(2)).toBeCloseTo(1 / 3, 12);
    expect(breakEvenShare(0.5)).toBeCloseTo(2 / 3, 12);
  });

  it("declares its thresholds: 5 and 15 points, 30 trades, 95 %", () => {
    expect(DEFAULT_VERDICT_POLICY).toEqual({
      marginPoints: 5,
      strongPoints: 15,
      minSample: 30,
      confidence: 0.95,
    });
  });

  describe("resampled odds", () => {
    it("measures the target's share of decided replays against break-even", () => {
      // 2R: break-even 33.3 %. 450 of 900 decided is 50 % — 16.7 points over.
      const v = judgeResampled(resampled(450, 450, 2));
      expect(v.decided).toBe(900);
      expect(v.targetShare).toBe(0.5);
      expect(v.breakEven).toBeCloseTo(1 / 3, 12);
      expect(v.edgePoints).toBeCloseTo(16.667, 3);
      expect(v.verdict).toBe("FAVOURABLE_STRONG");
    });

    it("grades the edge at the declared thresholds, either way", () => {
      // 1R: break-even exactly 50 %, so the share is the edge plus fifty.
      const at = (share: number) =>
        judgeResampled(resampled(share * 10, 1000 - share * 10, 1)).verdict;
      expect(at(65)).toBe("FAVOURABLE_STRONG");
      expect(at(64)).toBe("FAVOURABLE");
      expect(at(55)).toBe("FAVOURABLE");
      expect(at(54)).toBe("NEAR_BREAK_EVEN");
      expect(at(50)).toBe("NEAR_BREAK_EVEN");
      expect(at(46)).toBe("NEAR_BREAK_EVEN");
      expect(at(45)).toBe("UNFAVOURABLE");
      expect(at(36)).toBe("UNFAVOURABLE");
      expect(at(35)).toBe("UNFAVOURABLE_STRONG");
    });

    it("ignores undecided replays, and says so when none was decided", () => {
      // 60 targets and 40 stops among 1,000: the other 900 decide nothing.
      expect(judgeResampled(resampled(60, 40, 1))).toMatchObject({
        decided: 100,
        targetShare: 0.6,
        verdict: "FAVOURABLE",
      });
      expect(judgeResampled(resampled(0, 0, 1))).toEqual({
        decided: 0,
        targetShare: null,
        breakEven: 0.5,
        edgePoints: null,
        verdict: "NO_DECIDED_OUTCOMES",
      });
    });

    it("carries no interval: replays are not independent observations", () => {
      expect(judgeResampled(resampled(450, 450, 2))).not.toHaveProperty(
        "interval",
      );
    });
  });

  describe("the rule's history", () => {
    it("reports INSUFFICIENT_SAMPLE below thirty times fired, with its counts", () => {
      const v = judgeHistory(history(20, 9, 1));
      expect(v).toMatchObject({
        fired: 29,
        decided: 29,
        verdict: "INSUFFICIENT_SAMPLE",
      });
      expect(v.targetShare).toBeCloseTo(20 / 29, 12);
      expect(v.shareInterval).not.toBeNull();
      expect(v.rInterval).not.toBeNull();
      // Thirty is enough — and a trade the rule left early is one of them.
      expect(judgeHistory(history(21, 9, 1)).verdict).toBe("FAVOURABLE");
      expect(judgeHistory(history(20, 9, 1, 1)).verdict).not.toBe(
        "INSUFFICIENT_SAMPLE",
      );
    });

    it("has nothing to report when the rule never fired", () => {
      expect(judgeHistory(history(0, 0, 1))).toEqual({
        fired: 0,
        decided: 0,
        targetShare: null,
        shareInterval: null,
        breakEven: null,
        edgePoints: null,
        averageR: null,
        rInterval: null,
        verdict: "INSUFFICIENT_SAMPLE",
      });
    });

    it("carries the Wilson interval of the target's share", () => {
      // 60 of 100 at 95 %: the textbook Wilson interval, 0.502 .. 0.691.
      const v = judgeHistory(history(60, 40, 1));
      expect(v.shareInterval?.lower).toBeCloseTo(0.502, 3);
      expect(v.shareInterval?.upper).toBeCloseTo(0.6906, 3);
    });

    it("judges on the average R of every time it fired, with its interval", () => {
      // 60 at +1R and 40 at −1R: mean 0.2, sd 0.9847, so ±0.193 at 95 %.
      const v = judgeHistory(history(60, 40, 1));
      expect(v.averageR).toBeCloseTo(0.2, 12);
      expect(v.rInterval?.lower).toBeCloseTo(0.007, 3);
      expect(v.rInterval?.upper).toBeCloseTo(0.393, 3);
      expect(v.verdict).toBe("FAVOURABLE");
      expect(judgeHistory(history(40, 60, 1)).verdict).toBe("UNFAVOURABLE");
    });

    it("is INCONCLUSIVE while the interval of the average still holds zero", () => {
      // 55 of 100 at 1R is +0.1R on average, ±0.196: not shown to be an edge.
      const v = judgeHistory(history(55, 45, 1));
      expect(v.averageR).toBeCloseTo(0.1, 12);
      expect(v.verdict).toBe("INCONCLUSIVE");
      expect(judgeHistory(history(45, 55, 1)).verdict).toBe("INCONCLUSIVE");
    });

    it("is not flattered by the few trades that ran far enough to be decided", () => {
      // The stored year's EMA_CROSSOVER, in outline: 357 longs, 50 decided
      // and 56 % of those at a 2R target — 22.7 points over break-even —
      // while the 307 the rule left early lost a little each.
      const v = judgeHistory(history(28, 22, 2, 307, -0.1));
      expect(v).toMatchObject({ fired: 357, decided: 50, targetShare: 0.56 });
      expect(v.edgePoints).toBeCloseTo(22.667, 3);
      expect(v.averageR).toBeCloseTo(3.3 / 357, 9);
      expect(v.verdict).toBe("INCONCLUSIVE");
    });

    it("takes the share's break-even from the rule's own targets, not the plan's", () => {
      // The rule's decided trades aimed at 3R on average: break-even 25 %.
      const v = judgeHistory(history(40, 60, 3));
      expect(v.breakEven).toBe(0.25);
      expect(v.edgePoints).toBeCloseTo(15, 9);
    });
  });
});
