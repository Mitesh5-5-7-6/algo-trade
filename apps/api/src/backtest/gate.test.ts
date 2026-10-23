import { describe, expect, it } from "vitest";
import type { BacktestMetrics } from "./metrics.js";
import { judge } from "./gate.js";
import type { WalkForwardResult } from "./walk-forward.js";

/** Task 13.5 (design D6, Q1): the standard gate, each criterion with its value. */
const metrics = (over: Partial<BacktestMetrics> = {}): BacktestMetrics => ({
  metricsVersion: "1",
  trades: 60,
  sessions: 160,
  wins: 33,
  losses: 27,
  winRate: 0.55,
  gross: 9000,
  net: 6000,
  totalReturn: 0.009,
  netReturn: 0.006,
  charges: 2400,
  slippage: 600,
  expectancy: 100,
  expectancyInterval: { lower: 20, upper: 180 },
  expectancyPValue: 0.007,
  averageWin: 400,
  averageLoss: -266.67,
  profitFactor: 1.84,
  sharpe: 1.6,
  sortino: 2.4,
  maxDrawdown: 30_000,
  maxDrawdownPct: 0.03,
  averageHoldMinutes: 45,
  monthly: [],
  profitableMonths: 0.75,
  byRegime: {},
  ...over,
});
const wf = (
  normal: Partial<BacktestMetrics> = {},
  stressed: Partial<BacktestMetrics> = { expectancy: 40 },
  baseline: Partial<BacktestMetrics> = { expectancy: -50 },
): WalkForwardResult =>
  ({
    fingerprint: "f".repeat(64),
    outOfSample: {
      normal: metrics(normal),
      stressed: metrics(stressed),
      baseline: metrics(baseline),
    },
  }) as unknown as WalkForwardResult;

describe("the validation gate (13.5, D6)", () => {
  it("passes only when every criterion holds — and says each one's value", () => {
    const v = judge(wf());
    expect(v).toMatchObject({ gateVersion: "1", verdict: "PASS", failed: [] });
    expect(v.criteria.map((c) => [c.name, c.held])).toEqual([
      ["trades", true],
      ["expectancy", true],
      ["profitFactor", true],
      ["maxDrawdown", true],
      ["stressedExpectancy", true],
      ["againstBaseline", true],
    ]);
    expect(v.criteria.find((c) => c.name === "expectancy")?.value).toBe(
      "100.00 per Trade, p 0.0070",
    );
    expect(v.criteria.find((c) => c.name === "maxDrawdown")?.value).toBe(
      "3.00% (30000.00)",
    );
  });

  it.each([
    ["trades", { trades: 29 }, {}, {}],
    [
      "expectancy",
      { expectancy: -10, expectancyPValue: 0.9 },
      {},
      { expectancy: -50 },
    ],
    ["expectancy", { expectancyPValue: 0.05 }, {}, {}],
    ["profitFactor", { profitFactor: 1.1 }, {}, {}],
    ["maxDrawdown", { maxDrawdownPct: 0.1001 }, {}, {}],
    ["stressedExpectancy", {}, { expectancy: -1 }, {}],
    ["againstBaseline", {}, {}, { expectancy: 120 }],
  ])("fails on %s alone", (name, normal, stressed, baseline) => {
    const v = judge(
      wf(
        normal,
        { expectancy: 40, ...stressed },
        { expectancy: -50, ...baseline },
      ),
    );
    expect(v.verdict).toBe("FAIL");
    expect(v.failed).toEqual([name]);
  });

  it("holds at the thresholds' edges exactly as written", () => {
    expect(judge(wf({ trades: 30 })).verdict).toBe("PASS");
    expect(judge(wf({ maxDrawdownPct: 0.1 })).verdict).toBe("PASS");
    expect(judge(wf({}, { expectancy: 40 }, { expectancy: 100 })).verdict).toBe(
      "PASS",
    ); // equal to the baseline
  });

  it("fails what it cannot judge: no Trades at all", () => {
    const none = metrics({
      trades: 0,
      wins: 0,
      losses: 0,
      expectancy: null,
      expectancyPValue: null,
      profitFactor: null,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
    });
    const v = judge({
      fingerprint: "f".repeat(64),
      outOfSample: { normal: none, stressed: none, baseline: none },
    } as unknown as WalkForwardResult);
    expect(v.verdict).toBe("FAIL");
    expect(v.failed).toEqual([
      "trades",
      "expectancy",
      "profitFactor",
      "maxDrawdown",
      "stressedExpectancy",
      "againstBaseline",
    ]);
    expect(v.criteria.find((c) => c.name === "profitFactor")?.value).toBe(
      "n/a",
    );
  });

  it("counts no losing Trade as the best profit factor — when there were wins", () => {
    const v = judge(wf({ profitFactor: null, losses: 0 }));
    expect(v.criteria.find((c) => c.name === "profitFactor")).toMatchObject({
      value: "no losing Trade",
      held: true,
    });
  });

  it("lets a baseline that took no Trade set no bar", () => {
    expect(
      judge(wf({}, { expectancy: 40 }, { expectancy: null, trades: 0 }))
        .verdict,
    ).toBe("PASS");
  });
});
