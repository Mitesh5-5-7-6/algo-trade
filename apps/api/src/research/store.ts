import type { Db } from "mongodb";
import {
  istDateKey,
  istDayStart,
  minuteOfDayIST,
  parseHHMM,
  type CandleInterval,
} from "@neelkanth/core";
import { ResearchReportsRepository } from "@neelkanth/db";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import type { CounterfactualRequest } from "../counterfactual/run.js";
import { loadCandles } from "../replay/store.js";
import { DEFAULT_LOOKBACK_SESSIONS, runDay } from "./day.js";
import { buildDailyReports, isStale, type ReportInputs } from "./report.js";

const DAY_MS = 86_400_000;

export interface DailyResearchRequest extends Omit<
  CounterfactualRequest,
  "candles"
> {
  /** Indices the market reads beside the evaluated symbols. */
  indexSymbols: string[];
  interval: CandleInterval;
  /** IST dates, inclusive: the days to consider. */
  fromDate: string;
  toDate: string;
  /** "Now", for deciding which days are complete — injected, so a run is reproducible. */
  now: number;
  /** Also recompute every report whose inputs have since been revised (spec §5.8). */
  recomputeStale: boolean;
  lookbackSessions?: number;
}

export interface DailyResearchOutcome {
  /** `date|symbol|vN` written for the first time. */
  reported: string[];
  /** Recomputed because a bar they read was revised: the new versions. */
  recomputed: string[];
  /** Already reported, inputs unchanged. */
  current: number;
  /** Days in range whose session had not closed yet. */
  incomplete: string[];
}

/**
 * A day is complete once its session has closed: any earlier IST date, or
 * today after the close. A date with no bars is no session at all — a
 * closed market, not a gap (Phase 8 D6).
 */
export function isComplete(date: string, now: number, close: string): boolean {
  const today = istDateKey(now);
  return (
    date < today || (date === today && minuteOfDayIST(now) >= parseHHMM(close))
  );
}

/**
 * Research every completed trading day in range that has no report yet —
 * and, asked to, recompute every report a revised bar has made stale (Phase
 * 8 D6). Idempotent: run again, it adds nothing. It reads `candles` and
 * writes `research_reports`; nothing else, and nothing in trading state.
 */
export async function runDailyResearch(
  db: Db,
  request: DailyResearchRequest,
): Promise<DailyResearchOutcome> {
  const k = request.lookbackSessions ?? DEFAULT_LOOKBACK_SESSIONS;
  const regimeSymbol = (request.regime ?? DEFAULT_REGIME_MODEL).symbol;
  const symbols = [
    ...new Set([...request.symbols, ...request.indexSymbols, regimeSymbol]),
  ];
  // Enough calendar days before the first date to hold its K sessions,
  // through weekends and a long holiday.
  const loadFrom = istDateKey(
    istDayStart(request.fromDate) - (3 * k + 14) * DAY_MS,
  );
  const candles = await loadCandles(
    db,
    symbols,
    request.interval,
    loadFrom,
    request.toDate,
  );

  const evaluated = new Set(request.symbols);
  const days = [
    ...new Set(
      candles
        .filter((c) => evaluated.has(c.symbol))
        .map((c) => istDateKey(c.ts))
        .filter((d) => d >= request.fromDate && d <= request.toDate),
    ),
  ].sort();

  const repo = new ResearchReportsRepository(db);
  const outcome: DailyResearchOutcome = {
    reported: [],
    recomputed: [],
    current: 0,
    incomplete: [],
  };
  for (const date of days) {
    if (!isComplete(date, request.now, request.hours.close)) {
      outcome.incomplete.push(date);
      continue;
    }
    // Which symbols need a report, and at which version.
    const due = new Map<string, number>();
    for (const symbol of request.symbols) {
      const latest = await repo.latest("DAY", date, symbol);
      if (latest === null) due.set(symbol, 1);
      else if (
        request.recomputeStale &&
        isStale(
          {
            sessions: latest.sessions,
            inputs: latest.report["inputs"] as ReportInputs,
          },
          candles,
        )
      )
        due.set(symbol, latest.version + 1);
      else outcome.current += 1;
    }
    if (due.size === 0) continue;

    const day = await runDay({
      ...request,
      date,
      candles,
      lookbackSessions: k,
    });
    for (const report of buildDailyReports(day, request.now)) {
      const version = due.get(report.symbol);
      if (version === undefined) continue;
      const versioned = {
        ...report,
        version,
        reportId: report.reportId.replace(/\|v\d+$/, `|v${String(version)}`),
      };
      const saved = await repo.save({
        reportId: versioned.reportId,
        period: "DAY",
        date,
        symbol: report.symbol,
        version,
        generatedAt: request.now,
        fingerprint: report.fingerprint,
        sessions: report.sessions,
        inputsFingerprint: report.inputs.fingerprint,
        report: versioned,
      });
      if (!saved) continue; // another run got there first — not ours to overwrite
      (version === 1 ? outcome.reported : outcome.recomputed).push(
        `${date}|${report.symbol}|v${String(version)}`,
      );
    }
  }
  return outcome;
}
