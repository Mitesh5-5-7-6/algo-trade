import { createHash } from "node:crypto";
import { canonicalJson } from "@neelkanth/core";
import { aggregate, type Aggregate } from "./aggregate.js";
import {
  monthlyAnswers,
  PERIODIC_RESEARCH_VERSION,
  quarterlyAnswers,
  THRESHOLDS,
  weeklyAnswers,
  type MonthlyAnswers,
  type QuarterlyAnswers,
  type WeeklyAnswers,
} from "./questions.js";
import type { DailyReport } from "./report.js";
import {
  calendarFingerprint,
  coverageOf,
  windowSpan,
  type Coverage,
  type TradingCalendar,
  type TradingWindow,
} from "./windows.js";

/** A daily report as a window reads it: its id and fingerprint, and its body. */
export interface DailyRef {
  reportId: string;
  fingerprint: string;
  report: Pick<DailyReport, "date" | "symbol" | "patterns" | "trades">;
}

/** A week, month or quarter, researched (Phase 9). */
export interface WindowReport {
  reportId: string;
  period: TradingWindow["period"];
  windowId: string;
  fromDate: string;
  toDate: string;
  /** Pooled across instruments: window reports are about the market. */
  symbol: "ALL";
  version: number;
  generatedAt: number;
  periodicResearchVersion: string;
  thresholds: typeof THRESHOLDS;
  calendar: { source: string; fingerprint: string; tradingDays: string[] };
  /** Per instrument: what the calendar expected, and what was missing or unexpected. */
  coverage: Record<string, Coverage>;
  /** Every daily report aggregated, by id and fingerprint — what a revision is detected against. */
  inputs: {
    reports: { reportId: string; fingerprint: string }[];
    fingerprint: string;
  };
  aggregate: Aggregate;
  answers: WeeklyAnswers | MonthlyAnswers | QuarterlyAnswers;
  /** sha256 of everything above except its id, version and generation time. */
  fingerprint: string;
}

const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** `WEEK|2026-W10|ALL|v1`. */
export const windowReportIdOf = (
  period: string,
  windowId: string,
  version: number,
): string => `${period}|${windowId}|ALL|v${String(version)}`;

/** The inputs' fingerprint — the set of daily reports read, in any order. */
export function windowInputs(
  dailies: readonly DailyRef[],
): WindowReport["inputs"] {
  const reports = dailies
    .map((d) => ({ reportId: d.reportId, fingerprint: d.fingerprint }))
    .sort((a, b) =>
      a.reportId < b.reportId ? -1 : a.reportId > b.reportId ? 1 : 0,
    );
  return { reports, fingerprint: sha256(reports) };
}

/**
 * Build a window's report (Phase 9 D3–D5) from the newest daily reports of
 * its instruments. Only reports inside the window's span are read; coverage
 * says, per instrument, which expected days had none and which reported days
 * the calendar says were closed.
 */
export function buildWindowReport(
  window: TradingWindow,
  calendar: TradingCalendar,
  instruments: readonly string[],
  dailies: readonly DailyRef[],
  generatedAt: number,
  version = 1,
): WindowReport {
  const inSpan = dailies.filter(
    (d) =>
      d.report.date >= window.fromDate &&
      d.report.date <= window.toDate &&
      instruments.includes(d.report.symbol),
  );
  const coverage: Record<string, Coverage> = {};
  for (const symbol of [...instruments].sort())
    coverage[symbol] = coverageOf(
      window,
      inSpan
        .filter((d) => d.report.symbol === symbol)
        .map((d) => d.report.date),
    );
  const agg = aggregate(inSpan.map((d) => d.report));
  let answers: WindowReport["answers"];
  if (window.period === "WEEK")
    answers = weeklyAnswers(agg, window.tradingDays.length);
  else if (window.period === "MONTH") answers = monthlyAnswers(agg);
  else {
    const months: Record<string, Aggregate> = {};
    for (const d of window.tradingDays) {
      const month = windowSpan("MONTH", d).windowId;
      if (months[month] !== undefined) continue;
      months[month] = aggregate(
        inSpan
          .filter((x) => windowSpan("MONTH", x.report.date).windowId === month)
          .map((x) => x.report),
      );
    }
    answers = quarterlyAnswers(agg, months);
  }
  const body = {
    period: window.period,
    windowId: window.windowId,
    fromDate: window.fromDate,
    toDate: window.toDate,
    symbol: "ALL" as const,
    periodicResearchVersion: PERIODIC_RESEARCH_VERSION,
    thresholds: THRESHOLDS,
    calendar: {
      source: calendar.source,
      fingerprint: calendarFingerprint(calendar),
      tradingDays: window.tradingDays,
    },
    coverage,
    inputs: windowInputs(inSpan),
    aggregate: agg,
    answers,
  };
  return {
    reportId: windowReportIdOf(window.period, window.windowId, version),
    version,
    generatedAt,
    ...body,
    fingerprint: sha256(body),
  };
}

/**
 * Whether a window report still stands (Phase 9 D5): the newest daily
 * reports of its span, by id and fingerprint, against those it read. A daily
 * superseded by a new version, or a report filling one of its gaps, makes it
 * stale; a change outside its span does not.
 */
export function isWindowStale(
  report: Pick<WindowReport, "fromDate" | "toDate" | "inputs" | "coverage">,
  latestDailies: readonly DailyRef[],
): boolean {
  const instruments = Object.keys(report.coverage);
  const inSpan = latestDailies.filter(
    (d) =>
      d.report.date >= report.fromDate &&
      d.report.date <= report.toDate &&
      instruments.includes(d.report.symbol),
  );
  return windowInputs(inSpan).fingerprint !== report.inputs.fingerprint;
}
