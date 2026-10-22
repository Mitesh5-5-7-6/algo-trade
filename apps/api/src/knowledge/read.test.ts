import { describe, expect, it } from "vitest";
import type { StrategyExperimentDoc } from "@neelkanth/db";
import type { TradeEvidence } from "../research/evidence.js";
import type { PatternObservation } from "../research/observations.js";
import type { DailyReport } from "../research/report.js";
import { hypothesis } from "../validation/test-support.js";
import {
  experimentHistoryOf,
  findPatterns,
  strategyMatrix,
  tradeHistory,
} from "./read.js";
import type { KnowledgeHit } from "./search.js";

/** Task 10.6 (design D6): the agent's read models — n, dates, versions and costs on every answer. */
const SYM = "NSE:X-INDEX";
const models = (slippageBps = 2) => ({
  counterfactualVersion: "2",
  slippage: { version: "1", model: { bps: slippageBps } },
  transactionCost: { version: "1", config: { brokerage: 20 } },
  detectors: [
    { patternId: "ORB_BREAKOUT", detectorVersion: "1.0.0", params: {} },
  ],
});
const trade = (
  key: string,
  strategyType: string,
  result: "WIN" | "LOSS" | "FLAT",
  net: number,
  preceding: string[] = [],
  regime: "BULLISH" | "BEARISH" | "NEUTRAL" = "BULLISH",
): TradeEvidence => ({
  key,
  tradeId: "1",
  strategyType,
  symbol: SYM,
  side: "LONG",
  quantity: 1,
  entry: { signalId: null, barTs: 0, time: 0, price: 100, reason: null },
  exit: { time: null, price: null, reason: "SQUARE_OFF" },
  outcome: {
    result,
    gross: net,
    charges: 0,
    slippage: 0,
    net,
    netPerUnit: net,
  },
  held: { bars: 1, minutes: 5 },
  excursion: { favourable: 0, adverse: 0 },
  preceding: {
    regime,
    patterns: preceding.map((patternId) => ({
      patternId,
      detectorVersion: "1.0.0",
      direction: "BULLISH",
      ts: 0,
      barsBeforeEntry: 0,
    })),
  },
});
const occurrence = (
  patternId: string,
  ts: number,
  strategies: PatternObservation["strategies"],
  regime: "BULLISH" | "BEARISH" = "BULLISH",
): PatternObservation => ({
  patternId,
  detectorVersion: "1.0.0",
  ts,
  direction: "BULLISH",
  evidence: {},
  marketContext: {},
  regime,
  strategies,
});
const report = (
  date: string,
  patterns: PatternObservation[],
  trades: TradeEvidence[],
  slippageBps = 2,
): DailyReport =>
  ({
    date,
    symbol: SYM,
    dailyResearchVersion: "1",
    models: models(slippageBps),
    patterns,
    trades,
    strategies: [
      {
        type: "ORB",
        eligible: true,
        strategyVersion: "cfg-orb",
        actionable: 0,
        holds: 0,
        mechanicalExits: 0,
        approved: 0,
        blocked: {},
        trades: 0,
        wins: 0,
        net: 0,
      },
      {
        type: "RSI",
        eligible: true,
        strategyVersion: "cfg-rsi",
        actionable: 0,
        holds: 0,
        mechanicalExits: 0,
        approved: 0,
        blocked: {},
        trades: 0,
        wins: 0,
        net: 0,
      },
      {
        type: "INDEX_OPTION_MOMENTUM",
        eligible: false,
        exclusion: { kind: "OPTION_CHAIN", reason: "no chain" },
      },
    ],
  }) as unknown as DailyReport;

const REPORTS = [
  report(
    "2026-03-03",
    [
      occurrence("ORB_BREAKOUT", 3, {
        ORB: { relation: "ENTERED", tradeKey: "ORB|X|1" },
        RSI: { relation: "FLAT" },
      }),
    ],
    [trade("ORB|X|1", "ORB", "LOSS", -30, ["ORB_BREAKOUT"], "BEARISH")],
  ),
  report(
    "2026-03-02",
    [
      occurrence("ORB_BREAKOUT", 2, {
        ORB: { relation: "ENTERED", tradeKey: "ORB|X|1" },
        RSI: { relation: "SIGNALLED" },
      }),
      occurrence("RSI_REVERSION", 1, { RSI: { relation: "HOLDING" } }),
    ],
    [
      trade("ORB|X|1", "ORB", "WIN", 50, ["ORB_BREAKOUT"]),
      trade("RSI|X|1", "RSI", "LOSS", -10, ["RSI_REVERSION"]),
    ],
  ),
  report(
    "2026-03-09",
    [
      occurrence("ORB_BREAKOUT", 9, {
        ORB: { relation: "ENTERED", tradeKey: "ORB|X|1" },
      }),
    ],
    [trade("ORB|X|1", "ORB", "WIN", 70, ["ORB_BREAKOUT"])],
    5,
  ),
];

describe("provenance on every answer (10.6, D6)", () => {
  it("carries n, the sessions read, asOf, versions and cost models", () => {
    const a = findPatterns(REPORTS, { patterns: ["ORB_BREAKOUT"] });
    expect(a).toMatchObject({
      readModelVersion: "1",
      n: 3,
      range: { fromDate: "2026-03-02", toDate: "2026-03-09" },
      asOf: null,
      sources: 3,
      versions: {
        dailyResearch: ["1"],
        counterfactual: ["2"],
        strategies: ["ORB@cfg-orb", "RSI@cfg-rsi"],
        detectors: ["ORB_BREAKOUT@1.0.0"],
      },
    });
    // Two distinct slippage models were in force; each is named once.
    expect(a.costs.map((c) => c.slippage)).toEqual([
      { version: "1", model: { bps: 2 } },
      { version: "1", model: { bps: 5 } },
    ]);
  });

  it("reads nothing after asOf — and says so", () => {
    const a = tradeHistory(REPORTS, { asOf: "2026-03-04" });
    expect(a.trades.map((t) => t.date)).toEqual([
      "2026-03-02",
      "2026-03-02",
      "2026-03-03",
    ]);
    expect(a).toMatchObject({
      asOf: "2026-03-04",
      range: { fromDate: "2026-03-02", toDate: "2026-03-03" },
      sources: 2,
    });
    expect(a.costs).toHaveLength(1);
  });

  it("an empty answer still says what it looked at", () => {
    const a = tradeHistory(REPORTS, { strategies: ["NONE"] });
    expect(a).toMatchObject({
      n: 0,
      sources: 3,
      summary: { expectancy: null },
    });
  });
});

describe("findPatterns (10.6)", () => {
  it("lists occurrences in time order, with what each strategy did and how its Trade ended", () => {
    const a = findPatterns(REPORTS, { patterns: ["ORB_BREAKOUT"] });
    expect(a.occurrences.map((o) => o.date)).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-09",
    ]);
    // The Trade key repeats across days; each occurrence finds its own day's Trade.
    expect(a.occurrences[0]?.strategies).toEqual([
      {
        type: "ORB",
        relation: "ENTERED",
        trade: { key: "ORB|X|1", result: "WIN", net: 50 },
      },
      { type: "RSI", relation: "SIGNALLED" },
    ]);
    expect(a.occurrences[1]?.strategies[0]?.trade?.result).toBe("LOSS");
  });

  it("orders a day's occurrences by when they fired, whatever the report's order", () => {
    expect(
      findPatterns(REPORTS, { toDate: "2026-03-02" }).occurrences.map(
        (o) => o.patternId,
      ),
    ).toEqual(["RSI_REVERSION", "ORB_BREAKOUT"]);
  });

  it("filters by regime and by date", () => {
    expect(
      findPatterns(REPORTS, { regimes: ["BEARISH"] }).occurrences,
    ).toHaveLength(0);
    expect(
      findPatterns(REPORTS, { fromDate: "2026-03-03", toDate: "2026-03-03" })
        .occurrences,
    ).toHaveLength(1);
  });
});

describe("tradeHistory (10.6)", () => {
  it("filters by strategy, preceding pattern, entry regime and outcome, and summarises exactly those", () => {
    const orb = tradeHistory(REPORTS, { strategies: ["ORB"] });
    expect(orb.summary).toEqual({
      wins: 2,
      losses: 1,
      flat: 0,
      net: 90,
      expectancy: 30,
    });
    expect(
      tradeHistory(REPORTS, { patterns: ["RSI_REVERSION"] }).trades.map(
        (t) => t.strategyType,
      ),
    ).toEqual(["RSI"]);
    expect(tradeHistory(REPORTS, { regimes: ["BEARISH"] }).n).toBe(1);
    expect(tradeHistory(REPORTS, { outcome: "WIN" }).summary.net).toBe(120);
  });
});

describe("strategyMatrix (10.6)", () => {
  it("one pattern against every strategy, with the excluded named", () => {
    const m = strategyMatrix(REPORTS, { patternId: "ORB_BREAKOUT" });
    expect(m.n).toBe(3);
    expect(m.rows).toEqual([
      {
        strategyType: "ORB",
        occurrences: 3,
        relations: { ENTERED: 3, SIGNALLED: 0, HOLDING: 0, FLAT: 0 },
        trades: 3,
        summary: { wins: 2, losses: 1, flat: 0, net: 90, expectancy: 30 },
      },
      {
        strategyType: "RSI",
        occurrences: 2,
        relations: { ENTERED: 0, SIGNALLED: 1, HOLDING: 0, FLAT: 1 },
        trades: 0,
        summary: { wins: 0, losses: 0, flat: 0, net: 0, expectancy: null },
      },
    ]);
    expect(m.excluded).toEqual([
      { strategyType: "INDEX_OPTION_MOMENTUM", reason: "OPTION_CHAIN" },
    ]);
  });

  /** RSI's own Trade on 03-02 followed RSI_REVERSION, not this pattern — it is not counted. */
  it("counts only the Trades the pattern led to", () => {
    const m = strategyMatrix(REPORTS, { patternId: "RSI_REVERSION" });
    expect(m.rows).toEqual([
      expect.objectContaining({
        strategyType: "RSI",
        occurrences: 1,
        trades: 0,
      }),
    ]);
  });
});

describe("experimentHistory (10.6)", () => {
  const h = hypothesis({ hypothesisId: "H-0001" });
  const hit = (
    docId: string,
    kind: string,
    sourceId: string,
    subject: { fromDate: string; toDate: string },
    facets: Partial<KnowledgeHit["facets"]> = {},
  ): KnowledgeHit => ({
    docId,
    kind,
    title: docId,
    text: docId,
    subject,
    facets: {
      symbols: [],
      patterns: [],
      strategies: [],
      regimes: [],
      ...facets,
    },
    source: {
      collection: "strategy_experiments",
      id: sourceId,
      version: null,
      fingerprint: "f".repeat(64),
    },
    score: null,
  });
  const experiments: StrategyExperimentDoc[] = [
    {
      experimentId: "H-0001",
      kind: "HYPOTHESIS",
      createdAt: 1,
      fingerprint: "a".repeat(64),
      manifest: h,
      result: {},
    },
    {
      experimentId: "H-0001:test",
      kind: "HYPOTHESIS_TEST",
      createdAt: 2,
      fingerprint: "b".repeat(64),
      manifest: { hypothesisId: "H-0001" },
      result: { gatePolicyVersion: "2" },
    },
    {
      experimentId: "H-0002:test",
      kind: "HYPOTHESIS_TEST",
      createdAt: 2,
      fingerprint: "c".repeat(64),
      manifest: { hypothesisId: "H-0002" },
      result: { gatePolicyVersion: "9" },
    },
  ];

  it("lists the entries with n and verdict, and the versions behind exactly them", () => {
    const a = experimentHistoryOf(
      [
        hit("HYPOTHESIS|H-0001", "HYPOTHESIS", "H-0001", {
          fromDate: "2025-09-29",
          toDate: "2026-09-28",
        }),
        hit(
          "FINDING|H-0001",
          "FINDING",
          "H-0001:test",
          { fromDate: "2025-09-29", toDate: "2026-09-28" },
          { n: 100, outcome: "SUPPORTED" },
        ),
      ],
      experiments,
      "2026-10-01",
    );
    expect(a.entries.map((e) => [e.kind, e.n, e.outcome])).toEqual([
      ["HYPOTHESIS", null, null],
      ["FINDING", 100, "SUPPORTED"],
    ]);
    expect(a).toMatchObject({
      n: 2,
      sources: 2,
      asOf: "2026-10-01",
      range: { fromDate: "2025-09-29", toDate: "2026-09-28" },
      versions: {
        gatePolicy: ["2"], // not H-0002's, which is not in the answer
        strategies: ["RSI@cfg-abc"],
        detectors: ["RSI_REVERSION@1.0.0"],
      },
      costs: [
        { slippage: { version: "1" }, transactionCost: { version: "1" } },
      ],
    });
  });
});
