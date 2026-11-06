import { describe, expect, it } from "vitest";
import {
  candidateDeclared,
  paperSessionReported,
  walkForwardJudged,
  weeklyReported,
} from "./research.js";

/** Task 16.9 — the research and lifecycle catalogue (design §5.1 D10). */

describe("research and lifecycle messages (16.9)", () => {
  it("tells of a declared candidate, as research, in operations", () => {
    expect(
      candidateDeclared({
        candidateId: "SC-0003",
        strategyType: "RSI",
        grid: [{}, { period: 21 }],
        symbols: ["NSE:NIFTY50-INDEX"],
        hypothesisId: "H-0003",
        statement: "RSI fades the open",
      }),
    ).toEqual({
      severity: "INFO",
      mode: "research",
      title: "Candidate declared: SC-0003 (RSI)",
      body: "2 variants on NSE:NIFTY50-INDEX, from H-0003: RSI fades the open",
      chat: "operations",
    });
  });

  it("tells a walk-forward's verdict, naming what failed", () => {
    const fail = walkForwardJudged({
      candidateId: "SC-0003",
      walkForwardId: "wf_SC-0003_1",
      folds: 6,
      verdict: "FAIL",
      failed: ["trades", "stressedExpectancy"],
      trades: 12,
      expectancy: -40.5,
    });
    expect(fail.title).toBe("Walk-forward FAIL: SC-0003");
    expect(fail.body).toBe(
      "wf_SC-0003_1, 6 folds, 12 out-of-sample trades, -₹40.5 per trade. Failed: trades, stressedExpectancy",
    );
    const pass = walkForwardJudged({
      candidateId: "SC-0001",
      walkForwardId: "wf_1",
      folds: 3,
      verdict: "PASS",
      failed: [],
      trades: 0,
      expectancy: null,
    });
    expect(pass.body).toBe(
      "wf_1, 3 folds, 0 out-of-sample trades, no expectancy",
    );
  });

  it("tells of a kept paper session report as PAPER", () => {
    const n = paperSessionReported({
      session: "2026-11-05",
      reportId: "psr_2026-11-05_1",
      clean: false,
      closedTrades: 3,
      net: 1250,
      differences: 2,
    });
    expect([n.mode, n.title, n.body, n.chat]).toEqual([
      "paper",
      "Paper session 2026-11-05: NOT CLEAN",
      "3 trades, net ₹1,250, 2 parity differences. psr_2026-11-05_1",
      "operations",
    ]);
  });

  it("gathers first-time weekly reports into one message, and nothing else", () => {
    expect(weeklyReported(["2026-W44|v1"])?.title).toBe(
      "Weekly report: 2026-W44",
    );
    const many = weeklyReported([
      "2026-W43|v1",
      "2026-10|v1", // a month
      "2026-Q3|v1", // a quarter
      "2026-W42|v2", // recomputed, not new
      "2026-W44|v1",
    ]);
    expect([many?.title, many?.body]).toEqual([
      "2 weekly reports",
      "2026-W43, 2026-W44",
    ]);
    expect(weeklyReported(["2026-10|v1", "2026-W42|v2"])).toBeNull();
    expect(weeklyReported([])).toBeNull();
  });

  it("puts every research message in operations, as INFO (D8, D9)", () => {
    for (const n of [
      candidateDeclared({
        candidateId: "SC-1",
        strategyType: "ORB",
        grid: [{}],
        symbols: [],
        hypothesisId: "H-1",
        statement: "s",
      }),
      weeklyReported(["2026-W01|v1"]),
    ]) {
      expect(n?.chat).toBe("operations");
      expect(n?.severity).toBe("INFO");
    }
  });
});
