import { beforeAll, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  type ResearchReportDoc,
  type StrategyExperimentDoc,
} from "@neelkanth/db";
import { createPatternRegistry } from "@neelkanth/patterns";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import { runCounterfactual } from "../counterfactual/run.js";
import { runDay } from "../research/day.js";
import { buildDailyReports, type DailyReport } from "../research/report.js";
import { buildWindowReport } from "../research/window-report.js";
import { windowOf } from "../research/windows.js";
import {
  hypothesisFingerprint,
  type Hypothesis,
} from "../validation/hypothesis.js";
import type { HypothesisTest } from "../validation/gate.js";
import { hypothesis } from "../validation/test-support.js";
import { KnowledgeDocumentSchema, type KnowledgeDocument } from "./document.js";
import {
  renderCounterfactual,
  renderDailyReport,
  renderDetector,
  renderHypotheses,
  renderWindowReport,
} from "./render.js";

/** Task 10.2 (design D1, D2): every source kind rendered — and every document carrying its context. */
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
let daily: DailyReport;
let dayDoc: ResearchReportDoc;

function asDoc(
  r: {
    reportId: string;
    version: number;
    fingerprint: string;
    inputs: { fingerprint: string };
  },
  period: ResearchReportDoc["period"],
  date: string,
  sessions: string[] = [date],
): ResearchReportDoc {
  return {
    reportId: r.reportId,
    period,
    date,
    symbol: period === "DAY" ? SYM : "ALL",
    version: r.version,
    generatedAt: 1,
    fingerprint: r.fingerprint,
    sessions,
    inputsFingerprint: r.inputs.fingerprint,
    report: r,
  };
}
const valid = (docs: KnowledgeDocument[]): boolean =>
  docs.every((d) => KnowledgeDocumentSchema.safeParse(d).success);

beforeAll(async () => {
  const day = await runDay({
    date: "2026-01-14",
    candles: await historicalBars(
      [0, 1, 2, 3, 4, 7, 8, 9],
      (d) => 1 + (d % 5) * 0.04 + d * 0.01,
    ),
    symbols: [SYM],
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 0,
    regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
  });
  const [first] = buildDailyReports(day, 1);
  if (first === undefined) throw new Error("no report");
  daily = first;
  dayDoc = asDoc(daily, "DAY", daily.date);
}, 120_000);

describe("a daily report, rendered (10.2)", () => {
  it("becomes the day, each of its Trades and each of its charts", () => {
    const docs = renderDailyReport(dayDoc);
    const count = (k: string) => docs.filter((d) => d.kind === k).length;
    expect(count("DAY")).toBe(1);
    expect(count("TRADE")).toBe(daily.trades.length);
    expect(count("CHART")).toBe(1 + daily.trades.length);
    expect(daily.trades.length).toBeGreaterThan(0);
    expect(new Set(docs.map((d) => d.docId)).size).toBe(docs.length);
    expect(valid(docs)).toBe(true);
  });

  it("points every document at the report it came from, and dates it to the day", () => {
    for (const d of renderDailyReport(dayDoc)) {
      expect(d.source).toEqual({
        collection: COLLECTIONS.researchReports,
        id: dayDoc.reportId,
        version: 1,
        fingerprint: dayDoc.fingerprint,
      });
      expect(d.subject).toEqual({
        fromDate: "2026-01-14",
        toDate: "2026-01-14",
      });
    }
  });

  it("gives a Trade its facets and its full context in words", () => {
    const e = daily.trades[0];
    if (e === undefined) throw new Error("no Trade");
    const t = renderDailyReport(dayDoc).find(
      (d) => d.kind === "TRADE" && d.docId.endsWith(e.key),
    );
    expect(t?.facets).toMatchObject({
      symbols: [SYM],
      strategies: [e.strategyType],
      regimes: [e.preceding.regime],
      outcome: e.outcome.result,
      n: 1,
    });
    for (const part of [
      "2026-01-14",
      "n = 1",
      "charges",
      "slippage",
      "net",
      "excursion",
    ])
      expect(t?.text).toContain(part);
  });

  it("is stable: the same report renders the same documents", () => {
    expect(renderDailyReport(dayDoc)).toEqual(renderDailyReport(dayDoc));
  });
});

describe("windows, experiments, hypotheses, detectors (10.2)", () => {
  it("renders a window with its coverage and answers", () => {
    const cal = { holidays: [], specialSessions: [], source: "test" };
    const w = buildWindowReport(
      windowOf("WEEK", "2026-01-14", cal),
      cal,
      [SYM],
      [
        {
          reportId: daily.reportId,
          fingerprint: daily.fingerprint,
          report: daily,
        },
      ],
      1,
    );
    const [doc] = renderWindowReport(
      asDoc(w, "WEEK", w.fromDate, w.calendar.tradingDays),
    );
    expect(doc).toMatchObject({
      docId: "WINDOW|WEEK|2026-W03",
      kind: "WINDOW",
      subject: { fromDate: "2026-01-12", toDate: "2026-01-18" },
    });
    expect(doc?.text).toContain("4 gap day(s)"); // one daily report in a five-day week
    expect(valid(doc === undefined ? [] : [doc])).toBe(true);
  });

  it("renders a counterfactual run with n on every pairing", async () => {
    const run = await runCounterfactual({
      candles: await historicalBars([0, 1], (d) => 1 + d * 0.05),
      symbols: [SYM],
      hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
      ...goldenBudget(),
      seed: 0,
      regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
    });
    const exp: StrategyExperimentDoc = {
      experimentId: "cf_1",
      kind: "COUNTERFACTUAL",
      createdAt: 1,
      fingerprint: run.fingerprint,
      manifest: run.manifest as unknown as Record<string, unknown>,
      result: { matrix: run.matrix, patterns: run.patterns },
    };
    const [doc] = renderCounterfactual(exp);
    expect(doc?.subject).toEqual({
      fromDate: "2026-01-05",
      toDate: "2026-01-06",
    });
    expect(doc?.text).toContain("Excluded: INDEX_OPTION_MOMENTUM");
    expect(valid(doc === undefined ? [] : [doc])).toBe(true);
  }, 120_000);

  it("renders each hypothesis, and each tested one's finding corrected within its family", () => {
    const h1: Hypothesis = hypothesis({ hypothesisId: "H-0001" });
    const h2: Hypothesis = hypothesis({
      hypothesisId: "H-0002",
      threshold: -5,
    });
    const test: HypothesisTest = {
      hypothesisId: "H-0001",
      hypothesisFingerprint: hypothesisFingerprint(h1),
      family: h1.family,
      testedAt: 2,
      gatePolicyVersion: "2",
      outOfSample: {
        dateRange: h1.outOfSample,
        n: 100,
        estimate: -40,
        interval: { lower: -60, upper: -20 },
        pValue: 0.01,
        verdict: "SUPPORTED",
        charges: 1,
        slippage: 1,
        net: -4000,
        runFingerprint: "x",
      },
      inSample: {
        dateRange: h1.inSample,
        n: 90,
        estimate: -30,
        interval: null,
        pValue: null,
        verdict: "SUPPORTED",
        charges: 1,
        slippage: 1,
        net: -2700,
        runFingerprint: "y",
      },
    };
    const hdoc = (h: Hypothesis): StrategyExperimentDoc => ({
      experimentId: h.hypothesisId,
      kind: "HYPOTHESIS",
      createdAt: 1,
      fingerprint: hypothesisFingerprint(h),
      manifest: h,
      result: {},
    });
    const tdoc: StrategyExperimentDoc = {
      experimentId: "H-0001:test",
      kind: "HYPOTHESIS_TEST",
      createdAt: 2,
      fingerprint: "a".repeat(64),
      manifest: {},
      result: test as unknown as Record<string, unknown>,
    };
    const docs = renderHypotheses([hdoc(h1), hdoc(h2)], [tdoc]);
    expect(docs.map((d) => d.docId)).toEqual([
      "HYPOTHESIS|H-0001",
      "HYPOTHESIS|H-0002",
      "FINDING|H-0001",
    ]);
    const finding = docs.find((d) => d.kind === "FINDING");
    expect(finding?.facets).toMatchObject({ outcome: "SUPPORTED", n: 100 });
    expect(finding?.text).toContain("family of 2"); // the untested member still counts
    expect(valid(docs)).toBe(true);
  });

  it("renders every built-in detector definition", () => {
    const docs = createPatternRegistry()
      .catalog()
      .flatMap((d) => renderDetector(d, "f".repeat(64)));
    expect(docs.map((d) => d.docId)).toContain("DETECTOR|ORB_BREAKOUT@1.0.0");
    expect(docs).toHaveLength(5);
    expect(valid(docs)).toBe(true);
  });
});
