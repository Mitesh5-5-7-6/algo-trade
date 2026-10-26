import {
  COLLECTIONS,
  type ResearchReportDoc,
  type StrategyExperimentDoc,
} from "@neelkanth/db";
import type { PatternDefinition } from "@neelkanth/core";
import type { MatrixRow } from "../counterfactual/matrix.js";
import type { CounterfactualManifest } from "../counterfactual/run.js";
import type { ChartSpec } from "../research/charts.js";
import type { TradeEvidence } from "../research/evidence.js";
import type { DailyReport } from "../research/report.js";
import type {
  MonthlyAnswers,
  QuarterlyAnswers,
  WeeklyAnswers,
} from "../research/questions.js";
import type { WindowReport } from "../research/window-report.js";
import { describeFinding, familyFindings } from "../validation/family.js";
import type { HypothesisTest } from "../validation/gate.js";
import type { Hypothesis } from "../validation/hypothesis.js";
import {
  makeDocument,
  type KnowledgeDocument,
  type SourceRef,
} from "./document.js";

const num = (x: number | null): string => (x === null ? "—" : x.toFixed(2));
const pct = (x: number | null): string =>
  x === null ? "—" : `${(x * 100).toFixed(1)}%`;
/**
 * A gap in the words it is searched by — "gap up", "gap down" — and not only
 * as a signed number, which a text search cannot find (Phase 10 acceptance F1).
 */
const gapWords = (gap: number | null): string =>
  gap === null
    ? "with no prior session in the run"
    : gap === 0
      ? "level with the prior close, no gap"
      : `with a gap ${gap > 0 ? "up" : "down"} of ${(Math.abs(gap) * 100).toFixed(2)}% from the prior close`;
const istTime = (ms: number): string =>
  new Date(ms + 19_800_000).toISOString().slice(11, 16);
const reportRef = (doc: ResearchReportDoc): SourceRef => ({
  collection: COLLECTIONS.researchReports,
  id: doc.reportId,
  version: doc.version,
  fingerprint: doc.fingerprint,
});

/** A daily report: the day, each of its Trades, each of its charts (Phase 10 D1). */
export function renderDailyReport(doc: ResearchReportDoc): KnowledgeDocument[] {
  const r = doc.report as unknown as DailyReport;
  const source = reportRef(doc);
  const subject = { fromDate: r.date, toDate: r.date };
  const f = r.features;
  const patternCounts = new Map<string, number>();
  for (const p of r.patterns)
    patternCounts.set(p.patternId, (patternCounts.get(p.patternId) ?? 0) + 1);
  const strategyLines = r.strategies.map((s) =>
    s.eligible
      ? `${s.type}: ${String(s.actionable)} proposals, ${String(s.approved)} approved, n = ${String(s.trades)} Trades, ${String(s.wins)} wins, net ${num(s.net)}`
      : `${s.type}: excluded (${s.exclusion.kind})`,
  );
  const volume = Object.entries(f.volumeQuality)
    .map(([q, n]) => `${q} ${String(n)}`)
    .join(", ");
  const day = makeDocument({
    docId: `DAY|${r.date}|${r.symbol}`,
    kind: "DAY",
    source,
    subject,
    facets: {
      symbols: [r.symbol],
      patterns: [...patternCounts.keys()],
      strategies: r.strategies.filter((s) => s.eligible).map((s) => s.type),
      regimes: [f.regimeAtClose],
      n: r.trades.length,
      period: "DAY",
    },
    title: `${r.symbol}, ${r.date}`,
    text:
      `${r.date} ${r.symbol}: opened ${gapWords(f.gapPct)}, ` +
      `closed ${pct(f.returnPct)} on the open (range ${num(f.range)}, 5m volatility ${f.realisedVolatility === null ? "—" : f.realisedVolatility.toFixed(5)}), ` +
      `${f.regimeAtClose} at the close; ${String(f.bars)} bars (volume ${volume})${f.specialSession ? ", a special session" : ""}. ` +
      `Patterns: ${[...patternCounts.entries()].map(([p, n]) => `${p} ×${String(n)}`).join(", ") || "none"}. ` +
      `${strategyLines.join("; ")}. n = ${String(r.trades.length)} Trades in all.`,
  });
  const trades = r.trades.map((e) => renderTrade(r, e, source));
  const charts = [r.charts.day, ...r.charts.trades].map((c) =>
    renderChart(r, c, source),
  );
  return [day, ...trades, ...charts];
}

function renderTrade(
  r: DailyReport,
  e: TradeEvidence,
  source: SourceRef,
): KnowledgeDocument {
  const preceded = e.preceding.patterns
    .map((p) => `${p.patternId} ${String(p.barsBeforeEntry)} bar(s) before`)
    .join(", ");
  return makeDocument({
    docId: `TRADE|${r.date}|${e.key}`,
    kind: "TRADE",
    source,
    subject: { fromDate: r.date, toDate: r.date },
    facets: {
      symbols: [e.symbol],
      patterns: e.preceding.patterns.map((p) => p.patternId),
      strategies: [e.strategyType],
      regimes: [e.preceding.regime],
      outcome: e.outcome.result,
      n: 1,
      period: "DAY",
    },
    title: `${e.strategyType} ${e.side} on ${e.symbol}, ${r.date} — ${e.outcome.result}`,
    text:
      `On ${r.date} ${e.strategyType} went ${e.side} on ${e.symbol} at ${istTime(e.entry.time)} IST (${num(e.entry.price)}), ` +
      `${e.entry.reason ?? "no reason recorded"}, in a ${e.preceding.regime} regime, after ${preceded || "no pattern in the bars before"}; ` +
      `exited ${e.exit.reason}${e.exit.time === null ? "" : ` at ${istTime(e.exit.time)} IST`} after ${String(e.held.bars)} bars. ` +
      `n = 1: ${e.outcome.result}, gross ${num(e.outcome.gross)}, charges ${num(e.outcome.charges)}, slippage ${num(e.outcome.slippage)}, net ${num(e.outcome.net)}; ` +
      `excursion +${num(e.excursion.favourable)} / −${num(e.excursion.adverse)} per unit.`,
  });
}

function renderChart(
  r: DailyReport,
  c: ChartSpec,
  source: SourceRef,
): KnowledgeDocument {
  const kinds = new Map<string, number>();
  for (const m of c.markers) kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1);
  return makeDocument({
    docId: `CHART|${c.chartId}`,
    kind: "CHART",
    source,
    subject: { fromDate: r.date, toDate: r.date },
    facets: {
      symbols: [c.symbol],
      patterns: [],
      strategies: c.chartId.includes("|trade|")
        ? [c.chartId.split("|trade|")[1]?.split("|")[0] ?? ""]
        : [],
      regimes: [],
      period: "DAY",
    },
    title: `Chart ${c.chartId}`,
    text:
      `Chart specification for ${c.symbol} on ${r.date}, ${istTime(c.start)}–${istTime(c.end)} IST, ${c.interval}: ` +
      `overlays ${c.overlays.map((o) => `${o.kind}${o.period === undefined ? "" : String(o.period)}`).join(", ") || "none"}; ` +
      `markers ${[...kinds.entries()].map(([k, n]) => `${k} ×${String(n)}`).join(", ") || "none"}` +
      `${c.annotations.some((a) => a.includes("omitted")) ? "; a volume overlay omitted (volume not REAL)" : ""}.`,
  });
}

/** A week, month or quarter (Phase 9). */
export function renderWindowReport(
  doc: ResearchReportDoc,
): KnowledgeDocument[] {
  const w = doc.report as unknown as WindowReport;
  const gaps = Object.entries(w.coverage).filter(
    ([, c]) => c.gaps.length > 0 || c.unexpected.length > 0,
  );
  const coverage =
    gaps.length === 0
      ? "coverage clean"
      : `coverage: ${gaps.map(([s, c]) => `${s} ${String(c.gaps.length)} gap day(s)${c.unexpected.length > 0 ? `, ${String(c.unexpected.length)} unexpected` : ""}`).join("; ")}`;
  let answers: string;
  if (w.period === "WEEK") {
    const a = w.answers as WeeklyAnswers;
    answers =
      `recurred: ${a.recurred.map((r) => `${r.patternId} on ${String(r.daysOccurred)} of ${String(a.tradingDays)} days`).join(", ") || "none"}; ` +
      `failed repeatedly: ${a.failedRepeatedly.map((r) => `${r.strategyType} on ${r.patternId} (n = ${String(r.trades.n)}, net ${num(r.trades.net)}, lost on ${String(r.trades.losingDays)} days)`).join(", ") || "none"}`;
  } else if (w.period === "MONTH") {
    const a = w.answers as MonthlyAnswers;
    const cond = (c: MonthlyAnswers["weaknesses"][number]) =>
      `${c.strategyType} after ${c.preceding} in ${c.regime} (n = ${String(c.trades.n)}, expectancy ${num(c.trades.expectancy)})`;
    answers = `weaknesses: ${a.weaknesses.map(cond).join(", ") || "none"}; opportunities: ${a.opportunities.map(cond).join(", ") || "none"}`;
  } else {
    const a = w.answers as QuarterlyAnswers;
    answers =
      a.pairs
        .filter((p) => p.verdict !== "INSUFFICIENT")
        .map(
          (p) =>
            `${p.strategyType} on ${p.patternId}: ${p.verdict} (${Object.entries(
              p.byRegime,
            )
              .map(([r, x]) => `${r} n = ${String(x.n)}`)
              .join(", ")})`,
        )
        .join("; ") || "no pair with enough Trades to judge";
  }
  const strategies = w.aggregate.strategies.map(
    (s) =>
      `${s.strategyType} n = ${String(s.trades.n)}, net ${num(s.trades.net)}`,
  );
  return [
    makeDocument({
      docId: `WINDOW|${w.period}|${w.windowId}`,
      kind: "WINDOW",
      source: reportRef(doc),
      subject: { fromDate: w.fromDate, toDate: w.toDate },
      facets: {
        symbols: w.aggregate.instruments,
        patterns: [...new Set(w.aggregate.pairs.map((p) => p.patternId))],
        strategies: w.aggregate.strategies.map((s) => s.strategyType),
        regimes: [...new Set(w.aggregate.conditions.map((c) => c.regime))],
        n: w.aggregate.strategies.reduce((n, s) => n + s.trades.n, 0),
        period: w.period,
      },
      title: `${w.period} ${w.windowId}`,
      text: `${w.period} ${w.windowId} (${w.fromDate} .. ${w.toDate}), ${String(w.calendar.tradingDays.length)} trading days, ${coverage}. ${strategies.join("; ")}. ${answers}.`,
    }),
  ];
}

/** A counterfactual run (Phase 6): each strategy on each pattern, pooled. */
export function renderCounterfactual(
  doc: StrategyExperimentDoc,
): KnowledgeDocument[] {
  const m = doc.manifest as unknown as CounterfactualManifest;
  const matrix = (doc.result["matrix"] ?? []) as MatrixRow[];
  const rows = matrix.filter(
    (r) => r.symbol === "ALL" && r.regime === "ALL" && r.trades.n > 0,
  );
  const days = m.dataset.days;
  return [
    makeDocument({
      docId: `COUNTERFACTUAL|${doc.experimentId}`,
      kind: "COUNTERFACTUAL",
      source: {
        collection: COLLECTIONS.strategyExperiments,
        id: doc.experimentId,
        version: null,
        fingerprint: doc.fingerprint,
      },
      subject: {
        fromDate: days[0] ?? "0001-01-01",
        toDate: days.at(-1) ?? "0001-01-01",
      },
      facets: {
        symbols: m.symbols,
        patterns: rows.map((r) => r.patternId).filter((p) => p !== "ALL"),
        strategies: m.strategies.filter((s) => s.eligible).map((s) => s.type),
        regimes: [],
        n: rows
          .filter((r) => r.patternId === "ALL")
          .reduce((n, r) => n + r.trades.n, 0),
      },
      title: `Counterfactual ${doc.experimentId}`,
      text:
        `Counterfactual run ${doc.experimentId} over ${days[0] ?? "?"} .. ${days.at(-1) ?? "?"} (${String(days.length)} sessions, ${m.symbols.join(", ")}): ` +
        rows
          .map(
            (r) =>
              `${r.strategyType} on ${r.patternId === "ALL" ? "every Trade" : r.patternId}: n = ${String(r.trades.n)}, win rate ${pct(r.trades.winRate)}, expectancy ${num(r.trades.expectancy)}, net ${num(r.trades.net)}`,
          )
          .join("; ") +
        `. Excluded: ${
          m.strategies
            .filter((s) => !s.eligible)
            .map((s) => s.type)
            .join(", ") || "none"
        }.`,
    }),
  ];
}

/** Hypotheses as registered, and their findings, corrected within each family (Phase 7). */
export function renderHypotheses(
  hypothesisDocs: StrategyExperimentDoc[],
  testDocs: StrategyExperimentDoc[],
): KnowledgeDocument[] {
  const out: KnowledgeDocument[] = [];
  const hypotheses = hypothesisDocs.map((d) => ({
    doc: d,
    h: d.manifest as unknown as Hypothesis,
  }));
  const tests = testDocs.map((d) => ({
    doc: d,
    t: d.result as unknown as HypothesisTest,
  }));
  for (const { doc, h } of hypotheses)
    out.push(
      makeDocument({
        docId: `HYPOTHESIS|${h.hypothesisId}`,
        kind: "HYPOTHESIS",
        source: {
          collection: COLLECTIONS.strategyExperiments,
          id: doc.experimentId,
          version: null,
          fingerprint: doc.fingerprint,
        },
        subject: {
          fromDate: h.inSample.fromDate,
          toDate: h.outOfSample.toDate,
        },
        facets: {
          symbols: [h.cell.symbol],
          patterns: [h.cell.patternId],
          strategies: [h.cell.strategyType],
          regimes: [h.cell.regime],
        },
        title: `${h.hypothesisId}: ${h.statement}`,
        text:
          `${h.hypothesisId} in family ${h.family}: "${h.statement}". Claim: ${h.metric} ${h.direction === "greater" ? ">" : "<"} ${String(h.threshold)} ` +
          `for ${h.cell.strategyType} on ${h.cell.patternId}, ${h.cell.symbol}, regime ${h.cell.regime}, at α ${String(h.alpha)}, judged only at n = ${String(h.minSample)} Trades or more;` +
          `formed on ${h.inSample.fromDate} .. ${h.inSample.toDate}, to be tested once on ${h.outOfSample.fromDate} .. ${h.outOfSample.toDate}.`,
      }),
    );
  for (const family of [...new Set(hypotheses.map((x) => x.h.family))].sort()) {
    const members = hypotheses.filter((x) => x.h.family === family);
    const memberTests = tests.filter((x) => x.t.family === family);
    for (const f of familyFindings(
      members.map((x) => x.h),
      memberTests.map((x) => x.t),
    )) {
      const testDoc = memberTests.find(
        (x) => x.t.hypothesisId === f.hypothesisId,
      )?.doc;
      if (testDoc === undefined) continue; // untested: the HYPOTHESIS document says so
      out.push(
        makeDocument({
          docId: `FINDING|${f.hypothesisId}`,
          kind: "FINDING",
          source: {
            collection: COLLECTIONS.strategyExperiments,
            id: testDoc.experimentId,
            version: null,
            fingerprint: testDoc.fingerprint,
          },
          subject: {
            fromDate: f.dateRange.fromDate,
            toDate: f.dateRange.toDate,
          },
          facets: {
            symbols: [f.cell.symbol],
            patterns: [f.cell.patternId],
            strategies: [f.cell.strategyType],
            regimes: [f.cell.regime],
            outcome: f.verdict,
            n: f.sampleSize,
          },
          title: `${f.hypothesisId}: ${f.verdict}`,
          text: describeFinding(f),
        }),
      );
    }
  }
  return out;
}

/** A detector definition (Phase 5): what one version of a pattern meant. */
export function renderDetector(
  def: PatternDefinition,
  fingerprint: string,
): KnowledgeDocument[] {
  return [
    makeDocument({
      docId: `DETECTOR|${def.patternId}@${def.detectorVersion}`,
      kind: "DETECTOR",
      source: {
        collection: COLLECTIONS.patterns,
        id: `${def.patternId}@${def.detectorVersion}`,
        version: null,
        fingerprint,
      },
      // A definition is about no period: it applies to every date, so no asOf excludes it.
      subject: { fromDate: "0001-01-01", toDate: "0001-01-01" },
      facets: {
        symbols: [],
        patterns: [def.patternId],
        strategies: [],
        regimes: [],
      },
      title: `${def.patternId} ${def.detectorVersion}`,
      text: `${def.patternId} version ${def.detectorVersion}: ${def.definition} Defaults ${JSON.stringify(def.defaultParams)}; ${def.volumeBased ? "volume-based — declines on untrusted volume" : "price only"}.`,
    }),
  ];
}
