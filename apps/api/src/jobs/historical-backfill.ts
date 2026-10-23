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

/**
 * Why a requested day holds no bars. Three causes, never merged.
 *
 * They look identical from the data — zero candles — and mean completely
 * different things. MARKET_CLOSED is correct and expected. DATA_MISSING
 * is a hole in the dataset that research must know about. API_FAILURE is
 * an operational problem that may fix itself on a re-run. Collapsing any
 * two of them either buries a real gap in holiday noise or raises an
 * alert every Diwali until someone stops reading the alerts.
 */
export type DayStatus = "MARKET_CLOSED" | "DATA_MISSING" | "API_FAILURE";

export interface MissingPeriod {
  /** Inclusive IST date keys. */
  fromDate: string;
  toDate: string;
  cause: DayStatus;
  /** Trading days in the period. Never counts closed days. */
  tradingDays: number;
  /** Present for API_FAILURE. */
  reason?: string;
}

/**
 * Whether this symbol's history can be described as the range that was
 * asked for.
 *
 * PARTIAL_HISTORY is not a warning to be tidied away later. A dataset
 * labelled "1 year" that holds eight months will be used as a year by
 * every backtest that touches it, and the error surfaces as a strategy
 * that behaves oddly in a period nobody can explain. The label travels
 * with the data so no reader has to remember.
 */
export type HistoryStatus = "COMPLETE" | "PARTIAL_HISTORY" | "EMPTY";

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
   * COMPLETE only when every requested trading day produced bars.
   *
   * Anything less is PARTIAL_HISTORY, and the caller must not describe
   * the result by the range it asked for.
   */
  status: HistoryStatus;
  /** First IST trading date actually stored, or null. */
  availableFrom: string | null;
  /** Last IST trading date actually stored, or null. */
  availableTo: string | null;
  /** Every gap, grouped into runs, each naming its cause. */
  missingPeriods: readonly MissingPeriod[];
  /**
   * True when a provider returned a contiguous prefix and stopped — the
   * signature of a silent range cap (§3.1 Q1).
   */
  truncatedResponses: number;
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
   * Weekend dates the exchange traded anyway — the Budget session and the
   * Diwali Muhurat session. Omitting them makes a real session look like a
   * weekend and throws its bars away.
   */
  specialSessions?: ReadonlySet<string>;
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

  const tradingDays = tradingDaysBetween(
    fromMs,
    toMs,
    deps.holidays,
    deps.specialSessions ?? new Set<string>(),
  );
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
  let truncatedResponses = 0;
  const daysWithNoData: string[] = [];
  const failures: { fromDate: string; toDate: string; reason: string }[] = [];
  /** Every day the run touched, with why it holds nothing (if it does). */
  const dayStatus = new Map<string, DayStatus>();
  const failureReason = new Map<string, string>();
  const storedDays = new Set<string>();

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
      if (result.coverage.truncated) truncatedResponses += 1;

      for (const candle of result.candles) {
        const applied = await deps.saveCandle(candle);
        if (applied) stored += 1;
        else superseded += 1;
        // A superseded bar still means the day is covered: a better
        // record is already stored, which is the opposite of a gap.
        storedDays.add(istDateKey(candle.ts));
      }

      // Which days the exchange was open for but nothing arrived. Derived from
      // what came back rather than from `result.empty`, so a range that
      // returned nine days out of ten names the missing one instead of
      // reporting the whole range as fine.
      const covered = new Set(result.candles.map((c) => istDateKey(c.ts)));
      for (const day of daysInRange)
        if (!covered.has(day) && tradingDaySet.has(day)) {
          daysWithNoData.push(day);
          dayStatus.set(day, "DATA_MISSING");
        }

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
      const reason = (error as Error).message;
      failures.push({
        fromDate: range.fromDate,
        toDate: range.toDate,
        reason,
      });
      // Distinct from DATA_MISSING: nobody knows what was in these days,
      // so a re-run is warranted. A missing day that was genuinely fetched
      // needs a different conversation.
      for (const day of daysInRange) {
        dayStatus.set(day, "API_FAILURE");
        failureReason.set(day, reason);
      }
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

  const covered = [...storedDays].sort();
  const missingPeriods = groupIntoPeriods(
    span.tradingDays,
    dayStatus,
    failureReason,
  );

  return {
    stored,
    superseded,
    rejected,
    daysWithNoData,
    pagesFetched,
    truncatedResponses,
    status:
      covered.length === 0
        ? "EMPTY"
        : missingPeriods.length === 0
          ? "COMPLETE"
          : "PARTIAL_HISTORY",
    availableFrom: covered[0] ?? null,
    availableTo: covered[covered.length - 1] ?? null,
    missingPeriods,
    failures,
  };
}

/**
 * Collapse per-day gaps into contiguous runs sharing one cause.
 *
 * A report naming 187 individual dates is one nobody reads. Three periods
 * with a cause each is one somebody acts on.
 *
 * Only TRADING days appear. A weekend inside a gap does not split it and
 * is never listed — the exchange being shut on Sunday is not a hole in
 * the dataset, and MARKET_CLOSED days are excluded from the requested set
 * before this point.
 */
function groupIntoPeriods(
  tradingDays: readonly string[],
  dayStatus: ReadonlyMap<string, DayStatus>,
  failureReason: ReadonlyMap<string, string>,
): MissingPeriod[] {
  const periods: MissingPeriod[] = [];
  let current: MissingPeriod | null = null;

  for (const day of tradingDays) {
    const cause = dayStatus.get(day);
    if (cause === undefined) {
      current = null;
      continue;
    }
    const reason = failureReason.get(day);
    if (
      current !== null &&
      current.cause === cause &&
      current.reason === reason
    ) {
      current.toDate = day;
      current.tradingDays += 1;
      continue;
    }
    current = {
      fromDate: day,
      toDate: day,
      cause,
      tradingDays: 1,
      ...(reason === undefined ? {} : { reason }),
    };
    periods.push(current);
  }
  return periods;
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
      `  ${symbol} [${row.status}]: stored ${String(row.stored)}, ` +
        `superseded ${String(row.superseded)}, rejected ${String(row.rejected)}, ` +
        `pages ${String(row.pagesFetched)}`,
    );
    lines.push(
      `    available: ${row.availableFrom ?? "—"} .. ${row.availableTo ?? "—"}`,
    );
    if (row.status === "PARTIAL_HISTORY")
      lines.push(
        "    PARTIAL_HISTORY — do not describe this dataset by the range " +
          "that was requested",
      );
    if (row.truncatedResponses > 0)
      lines.push(
        `    ${String(row.truncatedResponses)} response(s) stopped early — ` +
          "the page size may exceed the vendor cap (§3.1 Q1)",
      );
    for (const period of row.missingPeriods)
      lines.push(
        `    ${period.cause} ${period.fromDate}..${period.toDate} ` +
          `(${String(period.tradingDays)} trading day(s))` +
          (period.reason === undefined ? "" : `: ${period.reason}`),
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
