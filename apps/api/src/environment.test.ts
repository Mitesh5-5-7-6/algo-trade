import { describe, expect, it } from "vitest";
import { modeDatabaseProblem } from "./environment.js";

/** Task 14.1 (Phase 14 design D2, ADR §8): each mode runs on its own database only. */
describe("the mode's database (14.1, D2)", () => {
  it("runs paper on a paper database, or an isolated test one", () => {
    for (const db of [
      "neelkanth_paper",
      "neelkanth_paper_drill",
      "neelkanth_it_ctx",
      "neelkanth_ci_1",
    ])
      expect(modeDatabaseProblem("paper", db)).toBeNull();
  });

  it("refuses paper on the research, the live, or any other database", () => {
    for (const db of [
      "neelkanth_research",
      "neelkanth_live",
      "algotrade",
      "test",
      "neelkanth_paperx",
    ])
      expect(modeDatabaseProblem("paper", db)).toMatch(
        /^paper mode runs only on a paper database/,
      );
  });

  it("refuses live on a paper, research or test database", () => {
    expect(modeDatabaseProblem("live", "neelkanth_paper")).toMatch(
      /it is a paper database/,
    );
    expect(modeDatabaseProblem("live", "neelkanth_research")).toMatch(
      /it is the research database/,
    );
    expect(modeDatabaseProblem("live", "neelkanth_it_ctx")).toMatch(
      /integration-test database/,
    );
    expect(modeDatabaseProblem("live", "neelkanth_live")).toBeNull();
  });
});
