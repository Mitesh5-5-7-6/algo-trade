import { createHash } from "node:crypto";
import { canonicalJson, isTradingDayIST } from "@neelkanth/core";

/**
 * A trading calendar, declared (Phase 9 D1): the exchange's holidays and the
 * weekend dates it opened anyway, and where both came from. Never inferred
 * from which days have bars — that would file every data gap as a holiday
 * (spec §5.5).
 */
export interface TradingCalendar {
  holidays: readonly string[];
  specialSessions: readonly string[];
  /** e.g. "settings:global" or "NSE trading holidays 2025, 2026 (published)". */
  source: string;
}

export type Period = "WEEK" | "MONTH" | "QUARTER";

/** A window's calendar span and its trading days within it. */
export interface TradingWindow {
  period: Period;
  /** `2026-W10`, `2026-03`, `2026-Q1`. */
  windowId: string;
  /** The calendar span, both ends inclusive. */
  fromDate: string;
  toDate: string;
  /** The calendar's trading days in the span, in order. */
  tradingDays: string[];
}

const DAY_MS = 86_400_000;
const keyOf = (utcMidnight: number): string =>
  new Date(utcMidnight).toISOString().slice(0, 10);
const utcOf = (date: string): number => {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

/** The calendar span and id of the window of `period` holding `date`. */
export function windowSpan(
  period: Period,
  date: string,
): { windowId: string; fromDate: string; toDate: string } {
  const t = utcOf(date);
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (period === "WEEK") {
    // ISO 8601: weeks run Monday–Sunday; a week belongs to the year of its Thursday.
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const monday = t - dow * DAY_MS;
    const thursday = monday + 3 * DAY_MS;
    const isoYear = new Date(thursday).getUTCFullYear();
    const week =
      Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / DAY_MS / 7) + 1;
    return {
      windowId: `${String(isoYear)}-W${String(week).padStart(2, "0")}`,
      fromDate: keyOf(monday),
      toDate: keyOf(monday + 6 * DAY_MS),
    };
  }
  if (period === "MONTH")
    return {
      windowId: `${String(y)}-${String(m + 1).padStart(2, "0")}`,
      fromDate: keyOf(Date.UTC(y, m, 1)),
      toDate: keyOf(Date.UTC(y, m + 1, 0)),
    };
  const q = Math.floor(m / 3);
  return {
    windowId: `${String(y)}-Q${String(q + 1)}`,
    fromDate: keyOf(Date.UTC(y, 3 * q, 1)),
    toDate: keyOf(Date.UTC(y, 3 * q + 3, 0)),
  };
}

/** The calendar's trading days in `[fromDate, toDate]`. */
export function tradingDaysIn(
  fromDate: string,
  toDate: string,
  calendar: TradingCalendar,
): string[] {
  const holidays = new Set(calendar.holidays);
  const special = new Set(calendar.specialSessions);
  const out: string[] = [];
  for (let t = utcOf(fromDate); t <= utcOf(toDate); t += DAY_MS) {
    const date = keyOf(t);
    if (isTradingDayIST(date, holidays, special)) out.push(date);
  }
  return out;
}

export function windowOf(
  period: Period,
  date: string,
  calendar: TradingCalendar,
): TradingWindow {
  const span = windowSpan(period, date);
  return {
    period,
    ...span,
    tradingDays: tradingDaysIn(span.fromDate, span.toDate, calendar),
  };
}

/** Every window of `period` touching `[fromDate, toDate]`, whole, in order. */
export function windowsBetween(
  period: Period,
  fromDate: string,
  toDate: string,
  calendar: TradingCalendar,
): TradingWindow[] {
  const out: TradingWindow[] = [];
  let date = fromDate;
  while (date <= toDate) {
    const w = windowOf(period, date, calendar);
    out.push(w);
    date = keyOf(utcOf(w.toDate) + DAY_MS);
  }
  return out;
}

/** The calendar's fingerprint — what a window report says it was built on. */
export function calendarFingerprint(calendar: TradingCalendar): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        holidays: [...calendar.holidays].sort(),
        specialSessions: [...calendar.specialSessions].sort(),
      }),
    )
    .digest("hex");
}

/**
 * Where the calendar and the reports disagree (Phase 9 D2). `gaps` are
 * trading days the calendar expects and no report covers — no bars, or not
 * yet researched. `unexpected` are days in the span with a report that the
 * calendar says were closed: a holiday list that is wrong, or a special
 * session not declared. A window is reported with both, never shortened.
 */
export interface Coverage {
  expected: number;
  reported: number;
  gaps: string[];
  unexpected: string[];
}

export function coverageOf(
  window: TradingWindow,
  reportedDays: readonly string[],
): Coverage {
  const expected = new Set(window.tradingDays);
  const inSpan = [...new Set(reportedDays)]
    .filter((d) => d >= window.fromDate && d <= window.toDate)
    .sort();
  const reported = new Set(inSpan);
  return {
    expected: expected.size,
    reported: inSpan.filter((d) => expected.has(d)).length,
    gaps: window.tradingDays.filter((d) => !reported.has(d)),
    unexpected: inSpan.filter((d) => !expected.has(d)),
  };
}

/**
 * A window is complete once its last trading day is: every day of it has
 * closed. One with no trading days at all completes when its span does.
 */
export function windowComplete(
  window: TradingWindow,
  isDayComplete: (date: string) => boolean,
): boolean {
  return isDayComplete(window.tradingDays.at(-1) ?? window.toDate);
}
