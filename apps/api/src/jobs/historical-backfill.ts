import {
  istDateKey,
  startOfDayIST,
  tradingDaysBetween,
  type CandleInterval,
} from "@neelkanth/core";
import type { HistoryProvider } from "@neelkanth/broker";

/**
 * Operator-triggered historical backfill
 * (docs/design/PHASE_1_HISTORICAL_DATA.md D6, §6, §7, task 1.10).
 *
 * No automatic backfill at boot. A boot-time fetch would make startup depend
 * on a third-party API and could silently rewrite history on every restart,
 * and ARCHITECTURE_DECISION §46 already separates being alive from being ready
 * to trade.
 *
 * The job is a pure function of `(symbols, interval, fromDate, toDate)` and is
 * safely re-runnable: storage is idempotent by D3, so re-running a completed
 * range rewrites identical values and reports them as stored.
 *
 * **It returns a report. It does not decide what the report means.** Whether
 * 12 days with no data is a holiday cluster or a broken token is a judgement
 * the operator makes with a calendar in hand; a job that decided for itself
 * would have to guess, and a wrong guess here is invisible.
 */

export interface BackfillRequest {
  symbols: readonly string[];
  interval: CandleInterval;
  /** "YYYY-MM-DD" IST, inclusive. */
  fromDate: string;
  /** "YYYY-MM-DD" IST, inclusive. */
  toDate: string;
}

export interface SymbolReport {
  /** Bars the storage layer accepted. */
  stored: number;
  /**
   * Bars refused because a higher-ranked bar is already stored (D3).
   *
   * Counted apart from `stored` because it is the number that answers "did
   * this run actually change anything?" — a re-run over live-aggregated bars
   * should supersede them, and a run that superseded nothing when it was
   * expected to is worth noticing.
   */
  superseded: number;
  /** Bars the provider returned but validation refused (§5). */
  rejected: number;
  /** Trading days the provider reported no data for. */
  daysWithNoData: readonly string[];
  pagesFetched: number;
  /**
   * Ranges that failed outright, with the reason.
   *
   * A failed range fails its range and is reported; it does not abort the run
   * (§7.3). A partial dataset the operator knows the shape of beats a run that
   * stopped at the first 500 and told nobody which days it never reached.
   */
  failures: readonly { fromDate: string; toDate: string; reason: string }[];
}

export interface BackfillReport {
  requestedTradingDays: number;
  perSymbol: ReadonlyMap<string, SymbolReport>;
  startedAt: number;
  finishedAt: number;
}

export interface BackfillDeps {
  /** Required. The job refuses to start without a real provider (D1). */
  history: HistoryProvider | null;
  /** Rank-conditional upsert; returns false when a better bar is stored. */
  saveCandle: (candle: {
    symbol: string;
    interval: CandleInterval;
    ts: number;
  }) => Promise<boolean>;
  /** Exchange holidays, from the same global settings the live session reads. */
  holidays: ReadonlySet<string>;
  /**
   * Days per fetched range. Independent of the provider's own page size: this
   * is how much the job asks for at a time, and the provider pages within it.
   */
  daysPerRange?: number;
  onProgress?: (event: BackfillProgress) => void;
}

export interface BackfillProgress {
  symbol: string;
  fromDate: string;
  toDate: string;
  stored: number;
  rejected: number;
  empty: boolean;
}

const DAY_MS = 86_400_000;
const DEFAULT_DAYS_PER_RANGE = 30;

/** "YYYY-MM-DD" IST → epoch ms at IST midnight that day. */
export function istMidnight(dateKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match)
    throw new Error(`invalid IST date "${dateKey}", expected YYYY-MM-DD`);
  const ms = Date.parse(`${dateKey}T00:00:00Z`) - (5 * 60 + 30) * 60_000;
  if (Number.isNaN(ms)) throw new Error(`invalid IST date "${dateKey}"`);
  // Date.parse accepts "2026-02-31" and rolls it forward; a silently shifted
  // range would backfill days nobody asked for.
  if (istDateKey(ms) !== dateKey)
    throw new Error(`"${dateKey}" is not a real calendar date`);
  return ms;
}

export async function runHistoricalBackfill(
  request: BackfillRequest,
  deps: BackfillDeps,
): Promise<BackfillReport> {
  // D1: the job requires a non-null provider and refuses to start without one,
  // rather than running to completion and reporting that it stored nothing.
  if (deps.history === null)
    throw new Error(
      "historical backfill requires a HistoryProvider; none was configured",
    );
  if (request.symbols.length === 0)
    throw new Error("historical backfill requires at least one symbol");

  const fromMs = istMidnight(request.fromDate);
  const toMs = istMidnight(request.toDate);
  if (toMs < fromMs)
    throw new Error(
      `range is inverted: ${request.fromDate} is after ${request.toDate}`,
    );

  const tradingDays = tradingDaysBetween(fromMs, toMs, deps.holidays);
  const daysPerRange = deps.daysPerRange ?? DEFAULT_DAYS_PER_RANGE;
  if (!Number.isInteger(daysPerRange) || daysPerRange < 1)
    throw new Error("daysPerRange must be a positive integer");

  const startedAt = Date.now();
  const perSymbol = new Map<string, SymbolReport>();

  // One symbol at a time, oldest range first (§7.1). A partial run then leaves
  // a contiguous prefix of history rather than a scatter of fragments, and
  // re-running resumes cleanly.
  for (const symbol of request.symbols) {
    perSymbol.set(
      symbol,
      await backfillSymbol(symbol, request, deps, {
        fromMs,
        toMs,
        daysPerRange,
        tradingDays,
      }),
    );
  }

  return {
    requestedTradingDays: tradingDays.length,
    perSymbol,
    startedAt,
    finishedAt: Date.now(),
  };
}

async function backfillSymbol(
  symbol: string,
  request: BackfillRequest,
  deps: BackfillDeps,
  span: {
    fromMs: number;
    toMs: number;
    daysPerRange: number;
    tradingDays: readonly string[];
  },
): Promise<SymbolReport> {
  const provider = deps.history;
  if (provider === null) throw new Error("unreachable: provider checked above");

  let stored = 0;
  let superseded = 0;
  let rejected = 0;
  let pagesFetched = 0;
  const daysWithNoData: string[] = [];
  const failures: { fromDate: string; toDate: string; reason: string }[] = [];

  const tradingDaySet = new Set(span.tradingDays);

  for (const range of splitIntoRanges(
    span.fromMs,
    span.toMs,
    span.daysPerRange,
  )) {
    // A range made entirely of weekends and holidays is not worth a call. The
    // exchange was shut; asking would spend rate-limit budget to be told so.
    const daysInRange = span.tradingDays.filter(
      (day) => day >= range.fromDate && day <= range.toDate,
    );
    if (daysInRange.length === 0) continue;

    try {
      const result = await provider.getHistory({
        symbol,
        interval: request.interval,
        fromTs: range.fromMs,
        // The provider's window is half-open, so ask up to the start of the
        // day AFTER the last one in this range.
        toTs: range.toMs + DAY_MS,
      });

      pagesFetched += result.pagesFetched;
      rejected += result.rejected.length;

      for (const candle of result.candles) {
        const applied = await deps.saveCandle(candle);
        if (applied) stored += 1;
        else superseded += 1;
      }

      // Which days the exchange was open for but nothing arrived. Derived from
      // what came back rather than from `result.empty`, so a range that
      // returned nine days out of ten names the missing one instead of
      // reporting the whole range as fine.
      const covered = new Set(result.candles.map((c) => istDateKey(c.ts)));
      for (const day of daysInRange)
        if (!covered.has(day) && tradingDaySet.has(day))
          daysWithNoData.push(day);

      deps.onProgress?.({
        symbol,
        fromDate: range.fromDate,
        toDate: range.toDate,
        stored: result.candles.length,
        rejected: result.rejected.length,
        empty: result.empty,
      });
    } catch (error) {
      // §7.3 — a failed range fails its range, not the run.
      failures.push({
        fromDate: range.fromDate,
        toDate: range.toDate,
        reason: (error as Error).message,
      });
      deps.onProgress?.({
        symbol,
        fromDate: range.fromDate,
        toDate: range.toDate,
        stored: 0,
        rejected: 0,
        empty: false,
      });
    }
  }

  return {
    stored,
    superseded,
    rejected,
    daysWithNoData,
    pagesFetched,
    failures,
  };
}

interface DateRange {
  fromMs: number;
  toMs: number;
  fromDate: string;
  toDate: string;
}

/**
 * Split an inclusive IST day range into consecutive chunks, oldest first.
 *
 * Calendar days, not trading days: the vendor call takes dates, and skipping
 * holidays here would produce ranges whose ends do not line up with anything
 * the operator asked for.
 */
export function splitIntoRanges(
  fromMs: number,
  toMs: number,
  daysPerRange: number,
): DateRange[] {
  const ranges: DateRange[] = [];
  if (toMs < fromMs) return ranges;

  const last = startOfDayIST(toMs);
  for (
    let start = startOfDayIST(fromMs);
    start <= last;
    start += daysPerRange * DAY_MS
  ) {
    const end = Math.min(start + (daysPerRange - 1) * DAY_MS, last);
    ranges.push({
      fromMs: start,
      toMs: end,
      fromDate: istDateKey(start),
      toDate: istDateKey(end),
    });
  }
  return ranges;
}

/** A human-readable summary of a run, for the CLI and the operator log. */
export function formatBackfillReport(report: BackfillReport): string {
  const lines: string[] = [];
  const seconds = ((report.finishedAt - report.startedAt) / 1000).toFixed(1);
  lines.push(
    `backfill finished in ${seconds}s — ${String(report.requestedTradingDays)} trading day(s) requested`,
  );

  for (const [symbol, row] of report.perSymbol) {
    lines.push(
      `  ${symbol}: stored ${String(row.stored)}, superseded ${String(row.superseded)}, ` +
        `rejected ${String(row.rejected)}, pages ${String(row.pagesFetched)}`,
    );
    if (row.daysWithNoData.length > 0) {
      const shown = row.daysWithNoData.slice(0, 10).join(", ");
      const more =
        row.daysWithNoData.length > 10
          ? ` (+${String(row.daysWithNoData.length - 10)} more)`
          : "";
      lines.push(
        `    no data on ${String(row.daysWithNoData.length)} trading day(s): ${shown}${more}`,
      );
    }
    for (const failure of row.failures)
      lines.push(
        `    FAILED ${failure.fromDate}..${failure.toDate}: ${failure.reason}`,
      );
  }
  return lines.join("\n");
}

/**
 * Whether a run is clean enough to treat as a successful ingestion.
 *
 * Deliberately strict about failures and silent about `daysWithNoData`: a
 * failed range means part of the dataset is absent and nobody knows what was
 * in it, whereas a day with no data may simply be a holiday the configured
 * calendar does not list yet. The first is always wrong; the second needs a
 * human with a calendar.
 */
export function backfillSucceeded(report: BackfillReport): boolean {
  for (const row of report.perSymbol.values())
    if (row.failures.length > 0) return false;
  return true;
}
