import { describe, expect, it } from "vitest";
import type { ToolCall } from "./answer.js";
import { proposalCatalog } from "./catalog.js";
import {
  checkProposal,
  checkProposals,
  MAX_PROPOSALS,
  paramsOf,
  ProposalSchema,
  type Proposal,
  type ProposalCatalog,
} from "./proposal.js";

/** Task 12.1 (design D1, D3): a proposal, checked before it can ever be registered. */
const evidence: ToolCall = {
  id: "c1",
  name: "strategy_matrix",
  input: { patternId: "ORB_BREAKOUT", regimes: ["BEARISH"] },
  outcome: {
    ok: true,
    evidence: true,
    provenance: {
      n: 797,
      range: { fromDate: "2025-10-01", toDate: "2026-03-27" },
      asOf: "2026-03-27",
      versions: {},
    },
    total: 1,
    rows: [
      { strategyType: "ORB", trades: 303, summary: { expectancy: -151.2 } },
    ],
    notes: [],
  },
};
const memory: ToolCall = {
  id: "c2",
  name: "search_research",
  input: {},
  outcome: {
    ok: true,
    evidence: false,
    provenance: { n: 1, range: null, asOf: "2026-03-27", versions: {} },
    total: 1,
    rows: [],
    notes: [],
  },
};
const CALLS = [evidence, memory];
const CATALOG: ProposalCatalog = {
  patterns: ["EMA_CROSS", "ORB_BREAKOUT", "RSI_REVERSION"],
  strategies: ["EMA_CROSSOVER", "ORB", "RSI"],
  symbols: ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"],
  checkParams: (_t, params) =>
    typeof params["rangeMinutes"] === "number" && params["rangeMinutes"] > 0
      ? null
      : "rangeMinutes: expected a positive number",
};
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  statement: "ORB loses money after ORB_BREAKOUT in a BEARISH regime",
  cell: {
    patternId: "ORB_BREAKOUT",
    strategyType: "ORB",
    symbol: "ALL",
    regime: "BEARISH",
  },
  metric: "expectancy",
  direction: "less",
  threshold: 0,
  strategyParams: [],
  rationale: [
    {
      statement:
        "In a BEARISH regime ORB took 303 Trades on ORB_BREAKOUT, -151.2 a Trade.",
      cites: ["c1"],
    },
  ],
  ...over,
});
const problems = (p: Proposal) =>
  checkProposal(p, 0, CALLS, "2026-03-27", CATALOG).problems;

describe("a proposal (12.1, D1)", () => {
  it("is a cell, a metric, a direction, a threshold, a variant and its evidence — no windows, no alpha", () => {
    expect(ProposalSchema.safeParse(proposal()).success).toBe(true);
    const keys = Object.keys(ProposalSchema.shape);
    for (const chosenByCode of [
      "inSample",
      "outOfSample",
      "alpha",
      "minSample",
      "run",
    ])
      expect(keys).not.toContain(chosenByCode);
  });

  it("names its variant's parameters as the strategy reads them", () => {
    expect(
      paramsOf(
        proposal({
          strategyParams: [
            { name: "rangeMinutes", value: 30 },
            { name: "allowShort", value: false },
          ],
        }),
      ),
    ).toEqual({ rangeMinutes: 30, allowShort: false });
  });
});

describe("checking a proposal (12.1, D3)", () => {
  it("accepts a claim on a known cell resting on evidence", () => {
    expect(problems(proposal())).toEqual([]);
    expect(
      problems(
        proposal({ strategyParams: [{ name: "rangeMinutes", value: 30 }] }),
      ),
    ).toEqual([]);
  });

  it("refuses an unknown pattern, a strategy that cannot be replayed, an instrument not researched", () => {
    expect(
      problems(
        proposal({
          cell: {
            patternId: "HEAD_AND_SHOULDERS",
            strategyType: "INDEX_OPTION_MOMENTUM",
            symbol: "NSE:RELIANCE-EQ",
            regime: "ALL",
          },
        }),
      ),
    ).toEqual([
      "pattern HEAD_AND_SHOULDERS is no detector — one of EMA_CROSS, ORB_BREAKOUT, RSI_REVERSION, or ALL",
      "strategy INDEX_OPTION_MOMENTUM cannot be replayed — one of EMA_CROSSOVER, ORB, RSI",
      "symbol NSE:RELIANCE-EQ is not researched — one of NSE:NIFTY50-INDEX, NSE:NIFTYBANK-INDEX, or ALL",
    ]);
  });

  it("accepts the baseline cell, ALL", () => {
    expect(
      problems(
        proposal({
          cell: {
            patternId: "ALL",
            strategyType: "ORB",
            symbol: "ALL",
            regime: "ALL",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("refuses a win-rate threshold outside 0 to 1", () => {
    expect(
      problems(
        proposal({ metric: "winRate", direction: "greater", threshold: 55 }),
      ),
    ).toEqual(["a win-rate threshold is a probability, 0 to 1 — not 55"]);
  });

  it("refuses a variant its strategy's own schema refuses, or one naming a parameter twice", () => {
    expect(
      problems(
        proposal({ strategyParams: [{ name: "rangeMinutes", value: -5 }] }),
      ),
    ).toEqual([
      "the variant is not a valid ORB: rangeMinutes: expected a positive number",
    ]);
    expect(
      problems(
        proposal({
          strategyParams: [
            { name: "rangeMinutes", value: 30 },
            { name: "rangeMinutes", value: 45 },
          ],
        }),
      ),
    ).toContain("a parameter is named twice");
  });

  it("refuses a proposal resting on memory, or on a number not in its evidence", () => {
    expect(
      problems(
        proposal({
          rationale: [{ statement: "Search says ORB loses.", cites: ["c2"] }],
        }),
      ),
    ).toEqual([
      "the rationale cites no evidence tool — a proposal must rest on evidence, not memory",
    ]);
    expect(
      problems(
        proposal({
          rationale: [{ statement: "ORB took 999 Trades.", cites: ["c1"] }],
        }),
      ),
    ).toEqual([
      "rationale 1: states 999, which is in none of the results it cites",
    ]);
  });

  it("allows at most five in one answer", () => {
    const six = Array.from({ length: MAX_PROPOSALS + 1 }, () => proposal());
    expect(checkProposals(six, CALLS, "2026-03-27", CATALOG)).toMatchObject({
      ok: false,
      problems: [
        "6 proposals — at most 5; keep the ones the evidence supports best",
      ],
    });
    expect(checkProposals([proposal()], CALLS, "2026-03-27", CATALOG).ok).toBe(
      true,
    );
  });
});

describe("the real catalog (12.1, D3)", () => {
  const catalog = proposalCatalog(["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"]);

  it("knows the detectors and the strategies the counterfactual can replay — not the derivative ones", () => {
    expect(catalog.patterns).toEqual(
      expect.arrayContaining([
        "EMA_CROSS",
        "ORB_BREAKOUT",
        "RSI_REVERSION",
        "HIGH_VOLUME_BREAKOUT",
        "VWAP_RECLAIM",
      ]),
    );
    expect([...catalog.strategies].sort()).toEqual([
      "EMA_CROSSOVER",
      "ORB",
      "RSI",
    ]);
  });

  it("checks a variant with the strategy's own schema", () => {
    expect(
      catalog.checkParams("EMA_CROSSOVER", { fast: 12, slow: 26 }),
    ).toBeNull();
    expect(
      catalog.checkParams("EMA_CROSSOVER", { fast: 30, slow: 20 }),
    ).toMatch(/fast period must be < slow period/);
    expect(
      catalog.checkParams("ORB", { rangeMinutes: "fifteen" }),
    ).not.toBeNull();
    expect(
      catalog.checkParams("ORB", { rangeMinutes: 30, quantity: 50 }),
    ).toBeNull();
  });

  /** 12.5 acceptance F2: the model proposed fast_ema/slow_ema, which the schema dropped silently. */
  it("refuses a parameter the strategy does not take — a schema drops it and runs the defaults", () => {
    expect(
      catalog.checkParams("EMA_CROSSOVER", { fast_ema: 30, slow_ema: 20 }),
    ).toMatch(
      /^EMA_CROSSOVER does not take fast_ema, slow_ema as given — its parameters include .*fast.*slow/,
    );
    expect(
      catalog.checkParams("RSI", { period: 21, oversoldLevel: 25 }),
    ).toMatch(/RSI does not take oversoldLevel as given/);
  });
});
