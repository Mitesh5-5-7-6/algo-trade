import { describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "@neelkanth/core";
import { DEFAULT_GLOBAL_SETTINGS } from "@neelkanth/db";
import { historyOf, type HistoryRequest } from "./history.js";
import { orbDay as day, ORB_DAY_SYMBOL as SYMBOL } from "./test-support.js";

const ORB: StrategyConfig = {
  strategyId: "odds_ORB",
  ownerId: "odds",
  type: "ORB",
  name: "ORB, the plan's rule",
  params: {},
  symbols: [SYMBOL],
  enabled: true,
  status: "active",
  createdAt: 0,
  updatedAt: 0,
};

const request = (
  candles: Candle[],
  over: Partial<HistoryRequest> = {},
): HistoryRequest => ({
  rule: ORB,
  side: "LONG",
  planDate: "2026-03-06",
  candles,
  hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
  allocatedCapital: 1_000_000,
  limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
  seed: 0,
  ...over,
});

/** Mon–Thu before the plan's Friday: one day of each kind. */
const WEEK = [
  ...day("2026-03-02", "TARGET"),
  ...day("2026-03-03", "STOP"),
  ...day("2026-03-04", "NEITHER"),
  ...day("2026-03-05", "QUIET"),
];

describe("a plan's rule over real past sessions (17.4)", () => {
  it("counts how each time the rule fired ended, and what it paid in R", async () => {
    const history = await historyOf(request(WEEK));
    expect(history).toMatchObject({
      sessions: 4,
      fired: 3,
      targetFirst: 1,
      stopFirst: 1,
      neither: 1,
      otherSide: 0,
    });
    // Entry 20,080, stop 20,000: 80 points of risk. The target, 20,180, pays
    // 100/80; the stop −1; the day that drifted to 20,100 pays 20/80.
    expect(history.outcomes.map((o) => [o.date, o.result, o.r])).toEqual([
      ["2026-03-02", "TARGET", 1.25],
      ["2026-03-03", "STOP", -1],
      ["2026-03-04", "NEITHER", 0.25],
    ]);
    expect(history.averageR).toBeCloseTo((1.25 - 1 + 0.25) / 3, 12);
    // What each trade aimed at, in units of its own risk — whether or not it
    // got there: the rule's break-even is read from these, not from the plan.
    expect(history.outcomes.map((o) => o.targetR)).toEqual([1.25, 1.25, 1.25]);
  });

  it("never replays the plan's own day, or any day after it", async () => {
    const withLater = [
      ...WEEK,
      ...day("2026-03-06", "TARGET"),
      ...day("2026-03-09", "TARGET"),
    ];
    const history = await historyOf(request(withLater));
    expect(history).toMatchObject({ sessions: 4, fired: 3, targetFirst: 1 });
    expect(history.outcomes.map((o) => o.date)).not.toContain("2026-03-06");
  });

  it("counts only the plan's side, and says how many times the rule went the other way", async () => {
    const candles = [...WEEK, ...day("2026-02-27", "SHORT_TARGET")];
    expect(await historyOf(request(candles))).toMatchObject({
      sessions: 5,
      fired: 3,
      otherSide: 1,
    });
    const short = await historyOf(request(candles, { side: "SHORT" }));
    expect(short).toMatchObject({
      fired: 1,
      targetFirst: 1,
      stopFirst: 0,
      otherSide: 3,
    });
    // Short from 19,920 with the stop at 20,000: the target 19,820 pays 100/80.
    expect(short.outcomes.map((o) => o.r)).toEqual([1.25]);
  });

  it("has no average R when the rule never fired", async () => {
    const history = await historyOf(
      request([...day("2026-03-04", "QUIET"), ...day("2026-03-05", "QUIET")]),
    );
    expect(history).toMatchObject({ sessions: 2, fired: 0, averageR: null });
  });

  it("refuses when no session comes before the plan's date", async () => {
    await expect(
      historyOf(request(WEEK, { planDate: "2026-03-02" })),
    ).rejects.toThrow(/no session before 2026-03-02/);
  });
});
