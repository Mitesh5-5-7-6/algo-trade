import { describe, expect, it } from "vitest";
import {
  checkAnswer,
  contextOf,
  holds,
  numbersIn,
  renderAnswer,
  SUBMIT_ANSWER_TOOL,
  type SubmittedAnswer,
  type ToolCall,
} from "./answer.js";

/** Task 11.2 (design D3, D4): claims citing calls, numbers traceable, context attached by code. */
const trades: ToolCall = {
  id: "c1",
  name: "trade_history",
  input: { strategies: ["ORB"], patterns: ["ORB_BREAKOUT"] },
  outcome: {
    ok: true,
    evidence: true,
    provenance: {
      n: 638,
      range: { fromDate: "2025-09-29", toDate: "2026-09-28" },
      asOf: "2026-09-30",
      versions: { dailyResearch: ["1"], strategies: ["ORB@cfg-0ec2"] },
      data: { sources: ["BROKER_HISTORICAL"], ingestionVersions: [1] },
      costs: [
        {
          slippage: { version: "1", model: { kind: "percent", pct: 0.0005 } },
          transactionCost: { version: "1" },
        },
      ],
    },
    total: 638,
    rows: [{ date: "2026-03-02", outcome: { result: "LOSS", net: -726.47 } }],
    notes: [],
    extra: {
      summary: {
        wins: 181,
        losses: 457,
        net: -94404.2581,
        expectancy: -147.969,
      },
    },
  },
};
const search: ToolCall = {
  id: "c2",
  name: "search_research",
  input: { text: "ORB" },
  outcome: {
    ok: true,
    evidence: false,
    provenance: {
      n: 3,
      range: { fromDate: "2026-03-02", toDate: "2026-03-09" },
      asOf: "2026-09-30",
      versions: {},
    },
    total: 3,
    rows: [{ text: "ORB lost 4,288 in week 10" }],
    notes: [],
  },
};
const failed: ToolCall = {
  id: "c3",
  name: "strategy_matrix",
  input: {},
  outcome: { ok: false, error: "boom" },
};
const CALLS = [trades, search, failed];
const answer = (
  statements: { statement: string; cites: string[] }[],
  summary = "ORB loses after its breakout.",
): SubmittedAnswer => ({
  summary,
  claims: statements,
  caveats: [],
});
const problemsOf = (a: SubmittedAnswer) =>
  checkAnswer(a, CALLS, "2026-09-30").claims.flatMap((c) => c.problems);

describe("reading the numbers a sentence states (11.2)", () => {
  it("finds amounts, decimals and percentages — not dates, times or identifiers", () => {
    expect(
      numbersIn(
        "On 2026-03-02 at 12:40 H-0001 in 2026-W10, Q1, EMA9 on 5m: n = 1,940, net -94,404.26, 28.4% and 0.05",
      ).map((n) => n.text),
    ).toEqual(["1,940", "-94,404.26", "28.4%", "0.05"]);
  });

  it("matches to the precision written, either sign, a percentage as a fraction", () => {
    const w = (s: string) =>
      numbersIn(s)[0] ?? { text: "", value: NaN, decimals: 0, percent: false };
    expect(holds([-94404.2581], w("lost 94,404"))).toBe(true);
    expect(holds([-94404.2581], w("lost 94,404.26"))).toBe(true);
    expect(holds([-94404.2581], w("lost 94,405"))).toBe(false);
    expect(holds([0.2837], w("won 28.4%"))).toBe(true);
    expect(holds([0.2837], w("won 28.5%"))).toBe(false);
  });
});

describe("the checker (11.2, D3)", () => {
  it("accepts claims whose every number and date is in the evidence cited", () => {
    const a = answer([
      {
        statement:
          "ORB took n = 638 Trades after ORB_BREAKOUT, 181 wins and 457 losses, net -94,404, -148 a Trade, 2025-09-29 to 2026-09-28.",
        cites: ["c1"],
      },
      {
        statement: "No tool reports news, so its effect cannot be judged.",
        cites: [],
      },
    ]);
    expect(checkAnswer(a, CALLS, "2026-09-30")).toMatchObject({
      ok: true,
      problems: [],
    });
  });

  it("rejects a number in none of the cited results", () => {
    expect(
      problemsOf(answer([{ statement: "ORB won 190 Trades.", cites: ["c1"] }])),
    ).toEqual(["states 190, which is in none of the results it cites"]);
  });

  it("rejects a number backed only by memory (§9.2)", () => {
    expect(
      problemsOf(
        answer([{ statement: "ORB lost 4,288 in week 10.", cites: ["c2"] }]),
      ),
    ).toEqual([
      "states a number but cites no evidence tool — research search is memory, not evidence (§9.2)",
    ]);
  });

  it("rejects a number with no citation at all", () => {
    expect(
      problemsOf(answer([{ statement: "ORB lost 457 times.", cites: [] }])),
    ).toHaveLength(1);
  });

  it("rejects an unknown or failed citation", () => {
    expect(
      problemsOf(answer([{ statement: "ORB loses.", cites: ["c9", "c3"] }])),
    ).toEqual([
      "cites c9, which is no call of this session",
      "cites c3, which failed",
    ]);
  });

  it("rejects a date after asOf, and one no cited result covers", () => {
    expect(
      problemsOf(
        answer([{ statement: "By 2026-10-15 it had lost.", cites: ["c1"] }]),
      ),
    ).toEqual(["states 2026-10-15, after asOf 2026-09-30"]);
    expect(
      problemsOf(
        answer([{ statement: "On 2025-01-02 it lost.", cites: ["c1"] }]),
      ),
    ).toEqual(["states 2025-01-02, which none of the results it cites covers"]);
  });

  it("rejects a summary number that no claim carries", () => {
    const a = answer(
      [{ statement: "ORB took n = 638 Trades.", cites: ["c1"] }],
      "ORB lost 94,404 on 638 Trades.",
    );
    expect(checkAnswer(a, CALLS, "2026-09-30").problems).toEqual([
      "the summary states 94,404, which no claim states — put it in a claim that cites its evidence",
    ]);
  });

  it("accepts an answer with no claims — the evidence does not answer it", () => {
    expect(
      checkAnswer(
        { summary: "Nothing was found.", claims: [], caveats: ["no news"] },
        CALLS,
        "2026-09-30",
      ).ok,
    ).toBe(true);
  });
});

describe("the rendered context (11.2, D4)", () => {
  it("names n, the sessions, asOf, versions, data and costs — written by code", () => {
    const text = contextOf(trades);
    for (const part of [
      "c1 trade_history",
      "n = 638",
      "sessions 2025-09-29 .. 2026-09-28",
      "as of 2026-09-30",
      "strategies ORB@cfg-0ec2",
      "data: BROKER_HISTORICAL, ingestion 1",
      'slippage {"version":"1","model":{"kind":"percent","pct":0.0005}}',
    ])
      expect(text).toContain(part);
    expect(contextOf(search)).toContain("(memory, not evidence)");
  });

  it("shows each claim with its evidence, and the verdict — UNSUPPORTED with its reasons", () => {
    const good = answer([
      { statement: "ORB took n = 638 Trades.", cites: ["c1"] },
    ]);
    expect(
      renderAnswer(good, CALLS, checkAnswer(good, CALLS, "2026-09-30")),
    ).toMatch(
      /1\. ORB took n = 638 Trades\.\n {3}\[c1 trade_history; n = 638;[^\n]*\][\s\S]*SUPPORTED: every number/,
    );
    const bad = answer([{ statement: "ORB won 190 Trades.", cites: ["c1"] }]);
    const text = renderAnswer(
      bad,
      CALLS,
      checkAnswer(bad, CALLS, "2026-09-30"),
    );
    expect(text).toContain("UNSUPPORTED:");
    expect(text).toContain(
      "states 190, which is in none of the results it cites",
    );
  });

  it("is a strict tool the model ends with", () => {
    expect(SUBMIT_ANSWER_TOOL).toMatchObject({
      name: "submit_answer",
      strict: true,
    });
    expect(SUBMIT_ANSWER_TOOL.input_schema.required).toEqual([
      "summary",
      "claims",
      "caveats",
    ]);
  });
});
