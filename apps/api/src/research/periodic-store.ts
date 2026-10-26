import type { Db } from "mongodb";
import {
  ResearchReportsRepository,
  type ResearchReportDoc,
} from "@neelkanth/db";
import type { DailyReport } from "./report.js";
import { isComplete } from "./store.js";
import {
  buildWindowReport,
  isWindowStale,
  windowReportIdOf,
  type DailyRef,
  type WindowReport,
} from "./window-report.js";
import {
  windowComplete,
  windowsBetween,
  type Period,
  type TradingCalendar,
} from "./windows.js";

export interface PeriodicResearchRequest {
  periods: Period[];
  /** The instruments a window pools. */
  symbols: string[];
  /** IST dates: every window touching this range is considered, whole. */
  fromDate: string;
  toDate: string;
  calendar: TradingCalendar;
  /** The session close, for deciding a window's last day is complete. */
  close: string;
  now: number;
  recomputeStale: boolean;
}

export interface PeriodicResearchOutcome {
  reported: string[];
  recomputed: string[];
  current: number;
  incomplete: string[];
}

const dailyRefOf = (doc: ResearchReportDoc): DailyRef => ({
  reportId: doc.reportId,
  fingerprint: doc.fingerprint,
  report: doc.report as unknown as DailyReport,
});

/**
 * Research every complete week, month and quarter touching the range that
 * has no report — and, asked to, recompute every stale one (Phase 9 D6).
 * A window is complete once its calendar's last trading day has closed; it
 * is built from the newest daily reports, gaps and all. Idempotent. Reads
 * `research_reports` (DAY) and writes `research_reports` (WEEK, MONTH,
 * QUARTER); nothing else.
 */
export async function runPeriodicResearch(
  db: Db,
  request: PeriodicResearchRequest,
): Promise<PeriodicResearchOutcome> {
  const repo = new ResearchReportsRepository(db);
  const outcome: PeriodicResearchOutcome = {
    reported: [],
    recomputed: [],
    current: 0,
    incomplete: [],
  };
  for (const period of request.periods) {
    const windows = windowsBetween(
      period,
      request.fromDate,
      request.toDate,
      request.calendar,
    );
    const first = windows[0];
    const last = windows.at(-1);
    if (first === undefined || last === undefined) continue;
    const dailies = (
      await repo.latestInRange("DAY", first.fromDate, last.toDate)
    ).map(dailyRefOf);
    for (const w of windows) {
      if (
        !windowComplete(w, (d) => isComplete(d, request.now, request.close))
      ) {
        outcome.incomplete.push(w.windowId);
        continue;
      }
      const latest = await repo.latest(period, w.fromDate, "ALL");
      let version: number;
      if (latest === null) version = 1;
      else if (
        request.recomputeStale &&
        isWindowStale(latest.report as unknown as WindowReport, dailies)
      )
        version = latest.version + 1;
      else {
        outcome.current += 1;
        continue;
      }
      const report = buildWindowReport(
        w,
        request.calendar,
        request.symbols,
        dailies,
        request.now,
        version,
      );
      const saved = await repo.save({
        reportId: windowReportIdOf(period, w.windowId, version),
        period,
        date: w.fromDate,
        symbol: "ALL",
        version,
        generatedAt: request.now,
        fingerprint: report.fingerprint,
        // The trading days it covers — so "which reports read this day?"
        // finds a window too. A window with none still names its span.
        sessions: w.tradingDays.length > 0 ? w.tradingDays : [w.fromDate],
        inputsFingerprint: report.inputs.fingerprint,
        report: report as unknown as Record<string, unknown>,
      });
      if (!saved) continue;
      (version === 1 ? outcome.reported : outcome.recomputed).push(
        `${w.windowId}|v${String(version)}`,
      );
    }
  }
  return outcome;
}
