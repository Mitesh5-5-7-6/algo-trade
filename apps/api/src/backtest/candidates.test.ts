import { describe, expect, it } from "vitest";
import { declarationProblems, nextCandidateId } from "./candidates.js";

/** Task 13.3 (design D1): a candidate's declaration, checked before it is kept. */
const NIFTY = "NSE:NIFTY50-INDEX";
const BANK = "NSE:NIFTYBANK-INDEX";
const ok = {
  strategyType: "EMA_CROSSOVER",
  grid: [{}, { fast: 12, slow: 26 }, { fast: 20, slow: 50 }],
  symbols: [NIFTY, BANK],
  hypothesisId: "H-0002",
  statement: "EMA_CROSSOVER, as configured or slower",
};

describe("declaring a candidate (13.3, D1)", () => {
  it("accepts a replayable strategy and a grid of distinct, valid variants — the configured one ({}) included", () => {
    expect(declarationProblems(ok)).toEqual([]);
  });

  it("refuses a strategy that cannot be replayed on its instruments", () => {
    expect(
      declarationProblems({
        ...ok,
        strategyType: "INDEX_OPTION_MOMENTUM",
        grid: [{}],
      })[0],
    ).toMatch(/^INDEX_OPTION_MOMENTUM cannot be replayed on NSE:/);
    expect(
      declarationProblems({ ...ok, strategyType: "NO_SUCH", grid: [{}] }),
    ).toEqual(["NO_SUCH is no strategy"]);
  });

  it("refuses a grid that is empty, too large, repeats itself, or holds a variant its strategy does not take", () => {
    expect(declarationProblems({ ...ok, grid: [] })).toEqual([
      "a grid holds 1 to 12 variants — not 0",
    ]);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      fast: i + 1,
      slow: 40,
    }));
    expect(declarationProblems({ ...ok, grid: thirteen })).toContain(
      "a grid holds 1 to 12 variants — not 13",
    );
    expect(
      declarationProblems({
        ...ok,
        grid: [
          { fast: 12, slow: 26 },
          { slow: 26, fast: 12 },
        ],
      }),
    ).toEqual(["variant 2 repeats another"]);
    expect(declarationProblems({ ...ok, grid: [{ fast_ema: 12 }] })).toEqual([
      expect.stringMatching(
        /^variant 1: EMA_CROSSOVER does not take fast_ema as given/,
      ) as string,
    ]);
    expect(
      declarationProblems({ ...ok, grid: [{ fast: 30, slow: 20 }] })[0],
    ).toMatch(/fast period must be < slow period/);
  });

  it("refuses a candidate with no instruments", () => {
    expect(declarationProblems({ ...ok, symbols: [] })).toContain(
      "a candidate names its instruments",
    );
  });

  it("numbers candidates SC-0001, SC-0002, …", () => {
    expect(nextCandidateId([])).toBe("SC-0001");
    expect(nextCandidateId(["SC-0001", "SC-0009"])).toBe("SC-0010");
  });
});
