import { beforeAll, describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import type { StrategyCandidateDoc } from "@neelkanth/db";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import {
  completeMonths,
  monthBounds,
  planFolds,
  walkForward,
  type WalkForwardResult,
  type WalkForwardSettings,
} from "./walk-forward.js";

/** Task 13.4 (design D4, D5): parameters chosen on the past only, tested on the month after. */
describe("months and folds (13.4, Q2)", () => {
  it("knows a month's bounds, leap years included", () => {
    expect(monthBounds("2026-02")).toEqual({
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
    });
    expect(monthBounds("2028-02").toDate).toBe("2028-02-29");
    expect(monthBounds("2026-12").toDate).toBe("2026-12-31");
  });

  it("counts only the months the data covers whole", () => {
    // The stored year: 2025-09-29 .. 2026-09-28 — September 2025 starts inside it, September 2026 ends inside it.
    const months = completeMonths("2025-09-29", "2026-09-28");
    expect(months[0]).toBe("2025-10");
    expect(months.at(-1)).toBe("2026-08");
    expect(months).toHaveLength(11);
  });

  it("rolls three months' training into one month's test, a month at a time", () => {
    const folds = planFolds(completeMonths("2025-09-29", "2026-09-28"));
    expect(folds).toHaveLength(8);
    expect(folds[0]).toEqual({
      train: { fromDate: "2025-10-01", toDate: "2025-12-31" },
      test: { fromDate: "2026-01-01", toDate: "2026-01-31" },
    });
    expect(folds.at(-1)?.test).toEqual({
      fromDate: "2026-08-01",
      toDate: "2026-08-31",
    });
  });

  it("breaks no fold across a gap in the months", () => {
    expect(
      planFolds(["2026-01", "2026-02", "2026-04", "2026-05", "2026-06"]),
    ).toEqual([]);
  });
});

const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
const CANDIDATE: StrategyCandidateDoc = {
  candidateId: "SC-0001",
  createdAt: 1,
  strategyType: "EMA_CROSSOVER",
  grid: [{}, { fast: 5, slow: 13 }],
  symbols: [SYM],
  hypothesisId: "H-0001",
  statement: "EMA_CROSSOVER, as configured or faster",
  fingerprint: "c".repeat(64),
};
const SETTINGS: WalkForwardSettings = {
  interval: "5m",
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  ...goldenBudget(),
  seed: 0,
  regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
  minTrainingTrades: 10,
};

/** Weekdays 2026-01-01 .. 2026-06-30, as offsets from the fixture's 2026-01-05. */
const weekdays = (): number[] => {
  const out: number[] = [];
  for (let d = -4; d <= 176; d += 1) {
    const day = new Date(Date.UTC(2026, 0, 5 + d)).getUTCDay();
    if (day !== 0 && day !== 6) out.push(d);
  }
  return out;
};
const price = (d: number) => 1 + (d % 7) * 0.03 + (d % 11) * 0.01;
let bars: Candle[];
let wf: WalkForwardResult;
let ran: Awaited<ReturnType<typeof walkForward>>["backtests"];
let folds: ReturnType<typeof planFolds>;

beforeAll(async () => {
  bars = await historicalBars(weekdays(), price);
  folds = planFolds(completeMonths("2026-01-01", "2026-06-30"));
  const out = await walkForward(bars, CANDIDATE, folds, SETTINGS);
  wf = out.result;
  ran = out.backtests;
}, 600_000);

describe("walking a candidate forward (13.4, D4)", () => {
  it("runs one fold per test month, with every variant on training", () => {
    expect(folds.map((f) => f.test.fromDate)).toEqual([
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
    expect(wf.folds).toHaveLength(3);
    for (const f of wf.folds)
      expect(f.training.map((t) => t.variant)).toEqual([1, 2]);
  });

  it("chooses, in each fold, the variant with the highest training expectancy among those with enough Trades", () => {
    for (const f of wf.folds) {
      const eligible = f.training.filter(
        (t) => t.trades >= 10 && t.expectancy !== null,
      );
      let best: (typeof eligible)[number] | undefined;
      for (const t of eligible)
        if (
          best === undefined ||
          (t.expectancy ?? -Infinity) > (best.expectancy ?? -Infinity)
        )
          best = t;
      expect(f.chosen).toBe(best?.variant ?? null);
      expect(f.tested === null).toBe(f.chosen === null);
    }
    expect(Object.values(wf.choices).reduce((a, n) => a + n, 0)).toBe(3);
    expect(wf.folds.some((f) => f.chosen !== null)).toBe(true);
  });

  it("pools the test months' Trades as the out-of-sample record, the baseline beside it", () => {
    expect(wf.outOfSample.normal.trades).toBeGreaterThan(0);
    expect(wf.outOfSample.baseline.trades).toBeGreaterThan(0);
    expect(wf.outOfSample.stressed.trades).toBe(wf.outOfSample.normal.trades);
    expect(wf.outOfSample.stressed.net).toBeLessThan(wf.outOfSample.normal.net);
    expect(
      wf.outOfSample.normal.monthly
        .map((m) => m.month)
        .every((m) => m >= "2026-04"),
    ).toBe(true);
  });

  it("runs the baseline as configured, and the test window at the variant chosen", () => {
    const runs = [...ran.values()];
    const baselines = runs.filter((r) => r.role === "baseline");
    expect(baselines).toHaveLength(3);
    for (const b of baselines) expect(b.backtest.params).toEqual({});
    for (const r of runs.filter((x) => x.role.startsWith("test")))
      expect(r.backtest.params).toEqual(
        CANDIDATE.grid[(wf.folds[r.fold - 1]?.chosen ?? 1) - 1],
      );
  });

  it("is deterministic", async () => {
    expect(
      (await walkForward(bars, CANDIDATE, folds, SETTINGS)).result.fingerprint,
    ).toBe(wf.fingerprint);
  }, 600_000);

  /** §8.2: never optimise and test on the same data. */
  it("lets no test month inform its fold's choice", async () => {
    const april = (c: Candle) =>
      c.ts >= Date.UTC(2026, 3, 1) - 19_800_000 &&
      c.ts < Date.UTC(2026, 4, 1) - 19_800_000;
    const changed = bars.map((c) =>
      april(c)
        ? {
            ...c,
            open: c.open * 1.07,
            high: c.high * 1.09,
            low: c.low * 1.05,
            close: c.close * 1.08,
          }
        : c,
    );
    const other = (await walkForward(changed, CANDIDATE, folds, SETTINGS))
      .result;
    // Fold 1 trains on Jan–Mar and tests on April: its training and choice cannot move.
    expect(other.folds[0]?.training).toEqual(wf.folds[0]?.training);
    expect(other.folds[0]?.chosen).toBe(wf.folds[0]?.chosen);
    expect(other.folds[0]?.baseline).not.toBe(wf.folds[0]?.baseline);
  }, 600_000);

  it("trades nothing in a fold where no variant had enough training Trades", async () => {
    const strict = (
      await walkForward(bars, CANDIDATE, folds.slice(0, 1), {
        ...SETTINGS,
        minTrainingTrades: 10_000,
      })
    ).result;
    expect(strict.folds[0]).toMatchObject({ chosen: null, tested: null });
    expect(strict.choices).toEqual({ none: 1 });
    expect(strict.outOfSample.normal.trades).toBe(0);
    expect(strict.outOfSample.baseline.trades).toBeGreaterThan(0);
  }, 600_000);
});
