import { describe, expect, it } from "vitest";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { hypothesis } from "./test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import { runCounterfactual } from "../counterfactual/run.js";
import {
  HypothesisSchema,
  hypothesisFingerprint,
  MIN_SAMPLE_FLOOR,
  nextHypothesisId,
  pinsFor,
  type Hypothesis,
} from "./hypothesis.js";

/** Task 7.3 (design D3): a claim, fixed before it is tested. */
const refuses = (h: Hypothesis): boolean =>
  !HypothesisSchema.safeParse(h).success;

describe("a hypothesis (7.3, D3)", () => {
  it("accepts a well-formed claim", () => {
    expect(HypothesisSchema.parse(hypothesis())).toEqual(hypothesis());
  });

  /** Spec §5.2 / PLAN §12: tested on data it was not formed on. */
  it("refuses an out-of-sample window that does not come after the in-sample one", () => {
    expect(
      refuses(
        hypothesis({
          outOfSample: { fromDate: "2026-03-27", toDate: "2026-09-28" },
        }),
      ),
    ).toBe(true);
    expect(
      refuses(
        hypothesis({
          outOfSample: { fromDate: "2025-01-01", toDate: "2025-06-30" },
        }),
      ),
    ).toBe(true);
    expect(
      refuses(
        hypothesis({
          inSample: { fromDate: "2026-03-27", toDate: "2025-09-29" },
        }),
      ),
    ).toBe(true);
  });

  it(`refuses a minimum sample below the floor of ${String(MIN_SAMPLE_FLOOR)}, and an absurd alpha`, () => {
    expect(refuses(hypothesis({ minSample: 29 }))).toBe(true);
    expect(refuses(hypothesis({ minSample: 100 }))).toBe(false);
    expect(refuses(hypothesis({ alpha: 0 }))).toBe(true);
    expect(refuses(hypothesis({ alpha: 0.5 }))).toBe(true);
  });

  it("refuses a win-rate threshold that is not a probability, and a malformed id", () => {
    expect(refuses(hypothesis({ metric: "winRate", threshold: 78 }))).toBe(
      true,
    );
    expect(refuses(hypothesis({ metric: "winRate", threshold: 0.78 }))).toBe(
      false,
    );
    expect(refuses(hypothesis({ hypothesisId: "H42" }))).toBe(true);
  });

  it("pins a pattern cell's detector version, and a baseline's none", () => {
    const noDetector = { ...hypothesis().pins };
    delete noDetector.detectorVersion;
    expect(refuses(hypothesis({ pins: noDetector }))).toBe(true);
    const baselineCell = { ...hypothesis().cell, patternId: "ALL" };
    expect(refuses(hypothesis({ cell: baselineCell }))).toBe(true);
    expect(refuses(hypothesis({ cell: baselineCell, pins: noDetector }))).toBe(
      false,
    );
  });

  it("refuses a cell on a symbol the run does not evaluate", () => {
    expect(
      refuses(
        hypothesis({
          cell: { ...hypothesis().cell, symbol: "NSE:NIFTYBANK-INDEX" },
        }),
      ),
    ).toBe(true);
  });

  it("is fingerprinted by its definition — not by when it was registered, nor key order", () => {
    const a = hypothesisFingerprint(hypothesis());
    expect(hypothesisFingerprint(hypothesis({ registeredAt: 9_999 }))).toBe(a);
    const reordered = Object.fromEntries(
      Object.entries(hypothesis()).reverse(),
    ) as Hypothesis;
    expect(hypothesisFingerprint(reordered)).toBe(a);
    expect(hypothesisFingerprint(hypothesis({ threshold: -10 }))).not.toBe(a);
  });

  it("numbers hypotheses H-0001, H-0002, …", () => {
    expect(nextHypothesisId([])).toBe("H-0001");
    expect(nextHypothesisId(["H-0001", "H-0007", "H-0003"])).toBe("H-0008");
  });
});

describe("pins read off the run a claim was formed on", () => {
  it("fixes the strategy, detector and model versions", async () => {
    const run = await runCounterfactual({
      candles: await historicalBars([0, 1], (d) => 1 + d * 0.07),
      symbols: ["NSE:TESTCO-EQ"],
      hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
      ...goldenBudget(),
      seed: 7,
      regime: { ...DEFAULT_REGIME_MODEL, symbol: "NSE:TESTINDEX-INDEX" },
    });
    const pins = pinsFor(run.manifest, {
      patternId: "EMA_CROSS",
      strategyType: "EMA_CROSSOVER",
      symbol: "ALL",
      regime: "ALL",
    });
    expect(pins).toMatchObject({
      strategyVersion: expect.stringMatching(/^cfg-/) as string,
      detectorVersion: "1.0.0",
      positionSizing: run.manifest.models.positionSizing,
      slippage: "1",
      transactionCost: "1",
      regime: { kind: "INDEX_TREND", symbol: "NSE:TESTINDEX-INDEX" },
      attribution: { windowBars: 0 },
    });
    const baseline = pinsFor(run.manifest, {
      patternId: "ALL",
      strategyType: "RSI",
      symbol: "ALL",
      regime: "BULLISH",
    });
    expect(baseline.detectorVersion).toBeUndefined();
    expect(() =>
      pinsFor(run.manifest, {
        patternId: "EMA_CROSS",
        strategyType: "INDEX_OPTION_PCR_OI",
        symbol: "ALL",
        regime: "ALL",
      }),
    ).toThrow(/0 versions/);
  }, 120_000);
});
