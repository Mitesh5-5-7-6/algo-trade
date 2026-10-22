import { beforeAll, describe, expect, it } from "vitest";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import {
  runCounterfactual,
  type CounterfactualRun,
} from "../counterfactual/run.js";
import type { MatrixRow, TradeStats } from "../counterfactual/matrix.js";
import { pinsFor, type Hypothesis, type HypothesisCell } from "./hypothesis.js";
import { testHypothesis } from "./gate.js";
import { hypothesis } from "./test-support.js";

/**
 * Task 7.4 (design D4, D5): one test, out of sample — minimum sample, then an
 * interval and a one-sided p-value, under exactly the versions the claim
 * pins. Real runs supply the manifests; each case sets the cell's numbers,
 * so every verdict is checked against arithmetic done by hand.
 */
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
const CELL: HypothesisCell = {
  patternId: "EMA_CROSS",
  strategyType: "EMA_CROSSOVER",
  symbol: "ALL",
  regime: "ALL",
};
const runOver = async (
  days: number[],
  params?: Record<string, Record<string, unknown>>,
) =>
  runCounterfactual({
    candles: await historicalBars(days, (d) => 1 + d * 0.05),
    symbols: [SYM],
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 0,
    regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
    ...(params === undefined ? {} : { strategyParams: params }),
  });

let IS: CounterfactualRun;
let OOS: CounterfactualRun;
beforeAll(async () => {
  IS = await runOver([0, 1]);
  OOS = await runOver([2, 3]);
}, 120_000);

const claim = (over: Partial<Hypothesis> = {}): Hypothesis =>
  hypothesis({
    cell: CELL,
    inSample: { fromDate: "2026-01-05", toDate: "2026-01-06" },
    outOfSample: { fromDate: "2026-01-07", toDate: "2026-01-08" },
    run: { ...hypothesis().run, symbols: [SYM], indexSymbols: [INDEX] },
    pins: pinsFor(IS.manifest, CELL),
    ...over,
  });

/** The run with the claim's cell replaced by these numbers. */
function withCell(
  run: CounterfactualRun,
  stats: Partial<TradeStats>,
): CounterfactualRun {
  const isCell = (r: MatrixRow) =>
    r.patternId === CELL.patternId &&
    r.strategyType === CELL.strategyType &&
    r.symbol === CELL.symbol &&
    r.regime === CELL.regime;
  const row = run.matrix.find(isCell);
  if (row === undefined) throw new Error("the fixture run has no such cell");
  return {
    ...run,
    matrix: [
      ...run.matrix.filter((r) => !isCell(r)),
      { ...row, trades: { ...row.trades, ...stats } },
    ],
  };
}

describe("the gate (7.4, D5)", () => {
  /** The first rule: below the minimum, no verdict on the rate at all. */
  it("refuses to judge a sample below the minimum, however striking", () => {
    const t = testHypothesis(
      claim({ metric: "winRate", direction: "greater", threshold: 0.5 }),
      IS,
      withCell(OOS, { n: 9, wins: 9, winRate: 1 }),
      2_000,
    );
    expect(t.outOfSample).toMatchObject({
      n: 9,
      estimate: 1,
      interval: null,
      pValue: null,
      verdict: "INSUFFICIENT_SAMPLE",
    });
  });

  it("judges a win rate by the exact binomial tail and a Wilson interval", () => {
    // P(X ≥ 60 | 100, ½) = 0.0284 < 0.05.
    const up = testHypothesis(
      claim({ metric: "winRate", direction: "greater", threshold: 0.5 }),
      IS,
      withCell(OOS, { n: 100, wins: 60, winRate: 0.6 }),
      2_000,
    );
    expect(up.outOfSample.pValue).toBeCloseTo(0.028443966820490392, 9);
    expect(up.outOfSample.verdict).toBe("SUPPORTED");
    // z = Φ⁻¹(0.95): the interval's lower side is the one-sided 95% bound.
    expect(up.outOfSample.interval?.lower).toBeCloseTo(0.5178, 3);
    // By symmetry P(X ≤ 40 | 100, ½) is the same tail.
    const down = testHypothesis(
      claim({ metric: "winRate", direction: "less", threshold: 0.5 }),
      IS,
      withCell(OOS, { n: 100, wins: 40, winRate: 0.4 }),
      2_000,
    );
    expect(down.outOfSample.pValue).toBeCloseTo(0.028443966820490392, 9);
    // 55 of 100: P(X ≥ 55) = 0.184 — not enough.
    const weak = testHypothesis(
      claim({ metric: "winRate", direction: "greater", threshold: 0.5 }),
      IS,
      withCell(OOS, { n: 100, wins: 55, winRate: 0.55 }),
      2_000,
    );
    expect(weak.outOfSample.verdict).toBe("NOT_SUPPORTED");
  });

  it("judges an expectancy by its spread: a one-sided z-test", () => {
    // mean −50, sd 200, n 100: z = −2.5, P(Z ≤ −2.5) = 0.00621.
    const strong = testHypothesis(
      claim(),
      IS,
      withCell(OOS, { n: 100, expectancy: -50, netStdDev: 200 }),
      2_000,
    );
    expect(strong.outOfSample.pValue).toBeCloseTo(0.006209665325776132, 6);
    expect(strong.outOfSample.verdict).toBe("SUPPORTED");
    // mean −10: z = −0.5, p = 0.3085.
    const weak = testHypothesis(
      claim(),
      IS,
      withCell(OOS, { n: 100, expectancy: -10, netStdDev: 200 }),
      2_000,
    );
    expect(weak.outOfSample.pValue).toBeCloseTo(0.3085375387259869, 6);
    expect(weak.outOfSample.verdict).toBe("NOT_SUPPORTED");
    expect(weak.outOfSample.interval?.upper).toBeCloseTo(
      -10 + 1.6448536 * 20,
      4,
    );
    const perUnit = testHypothesis(
      claim({ metric: "expectancyPerUnit" }),
      IS,
      withCell(OOS, { n: 100, expectancyPerUnit: -5, perUnitStdDev: 20 }),
      2_000,
    );
    expect(perUnit.outOfSample.pValue).toBeCloseTo(0.006209665325776132, 6);
  });

  /** The in-sample window is judged identically, and reported — never the verdict. */
  it("gives the verdict from the out-of-sample window only", () => {
    const t = testHypothesis(
      claim(),
      withCell(IS, { n: 100, expectancy: -80, netStdDev: 100 }),
      withCell(OOS, { n: 100, expectancy: 5, netStdDev: 100 }),
      2_000,
    );
    expect(t.inSample.verdict).toBe("SUPPORTED");
    expect(t.outOfSample.verdict).toBe("NOT_SUPPORTED");
    expect(t.outOfSample.dateRange).toEqual({
      fromDate: "2026-01-07",
      toDate: "2026-01-08",
    });
    expect(t.inSample.dateRange).toEqual({
      fromDate: "2026-01-05",
      toDate: "2026-01-06",
    });
    expect(t.outOfSample.runFingerprint).toBe(OOS.fingerprint);
  });

  it("treats a cell with no Trades in the window as n = 0", () => {
    const empty = { ...OOS, matrix: [] };
    expect(testHypothesis(claim(), IS, empty, 2_000).outOfSample).toMatchObject(
      { n: 0, verdict: "INSUFFICIENT_SAMPLE" },
    );
  });
});

describe("what the gate refuses outright (7.4, D4)", () => {
  it("a test that does not come after the registration", () => {
    expect(() =>
      testHypothesis(claim({ registeredAt: 5_000 }), IS, OOS, 5_000),
    ).toThrow(/after its registration/);
  });

  it("a run outside the window it stands for — the in-sample run as the test", () => {
    expect(() => testHypothesis(claim(), IS, IS, 2_000)).toThrow(
      /out-of-sample run holds 2026-01-05 .. 2026-01-06/,
    );
  });

  /** A run under other versions tests some other claim. */
  it("a run measured under versions the claim does not pin", async () => {
    const other = await runOver([2, 3], { EMA_CROSSOVER: { fast: 5 } });
    expect(() => testHypothesis(claim(), IS, other, 2_000)).toThrow(
      /strategyVersion/,
    );
    const otherAttribution = claim({
      pins: {
        ...pinsFor(IS.manifest, CELL),
        attribution: { version: "1", windowBars: 3 },
      },
    });
    expect(() => testHypothesis(otherAttribution, IS, OOS, 2_000)).toThrow(
      /attribution/,
    );
  }, 120_000);
});
