import {
  NSE_DEFAULT_SESSION,
  isWeekendIST,
  istDateKey,
  minuteOfDayIST,
  parseHHMM,
  type SessionConfig,
} from "./calendar.js";
import { intervalMs } from "./market.js";
import type { CandleInterval } from "./primitives.js";

/**
 * Vendor-independent validation for a historical bar
 * (docs/design/PHASE_1_HISTORICAL_DATA.md §5, task 1.7).
 *
 * Everything here is checkable without knowing which broker produced the row:
 * arithmetic that cannot be true of a real bar, and a timestamp that could not
 * have belonged to a session. Vendor-specific behaviour — what FYERS returns
 * for a holiday, whether index volume is real — is deliberately NOT here; that
 * is task 1.9, and it needs answers this repository does not have yet.
 *
 * **Nothing is ever repaired.** A bar that fails is rejected, counted and
 * reported. RND_RESEARCH_SPECIFICATION §5.7 treats stored candles as evidence,
 * and an interpolated bar is evidence of nothing — worse, once written it is
 * indistinguishable from a real one forever after.
 */

/** A bar as it arrives from a provider, before it is trusted enough to be a `Candle`. */
export interface RawBar {
  /** Bucket start, epoch ms. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarValidationOptions {
  interval: CandleInterval;
  /** Session boundaries to test `ts` against. Defaults to NSE 09:15–15:30. */
  session?: SessionConfig;
  /**
   * Exchange holidays as "YYYY-MM-DD" IST keys. Supplied from global settings
   * so ingestion and the live session cannot disagree about which days existed.
   * Weekends need no list and are always rejected.
   */
  holidays?: ReadonlySet<string>;
}

/**
 * Why a bar was refused — a stable, greppable tag plus a human sentence.
 *
 * The tag is what a run summary groups by. "4% rejected" is useless; "4%
 * rejected, all `ts-not-aligned`" names the bug in the paging code.
 */
export type BarRejectionCode =
  | "non-finite"
  | "price-not-positive"
  | "volume-negative"
  | "high-below-low"
  | "ohlc-inconsistent"
  | "ts-not-aligned"
  | "ts-outside-session"
  | "ts-non-trading-day";

export interface BarRejection {
  code: BarRejectionCode;
  /** One sentence naming the offending values, for the run report. */
  reason: string;
}

const PRICE_FIELDS = ["open", "high", "low", "close"] as const;

/**
 * Validate one bar. Returns `null` when it is sound, otherwise the FIRST
 * failure.
 *
 * First, not all — the checks are ordered cheapest and most fundamental first,
 * and a bar whose `high` is below its `low` is mangled in a way that makes any
 * further finding about it noise. One clear cause beats four symptoms.
 */
export function validateBar(
  bar: RawBar,
  options: BarValidationOptions,
): BarRejection | null {
  // NaN and Infinity survive every comparison below by returning false, so a
  // non-finite price would pass "high < low" and land in the database. JSON
  // cannot carry them, but a vendor's null coerced with Number() can.
  for (const field of [...PRICE_FIELDS, "volume", "ts"] as const) {
    const value = bar[field];
    if (!Number.isFinite(value)) {
      return {
        code: "non-finite",
        reason: `${field} is ${String(value)}, not a finite number`,
      };
    }
  }

  for (const field of PRICE_FIELDS) {
    if (bar[field] <= 0) {
      return {
        code: "price-not-positive",
        reason: `${field} is ${String(bar[field])}; not a tradeable price`,
      };
    }
  }

  if (bar.volume < 0) {
    return {
      code: "volume-negative",
      reason: `volume is ${String(bar.volume)}`,
    };
  }

  if (bar.high < bar.low) {
    return {
      code: "high-below-low",
      reason: `high ${String(bar.high)} is below low ${String(bar.low)}`,
    };
  }

  // The open and close must both lie inside the bar's own range. A row that
  // fails this is usually column misalignment, which is exactly the failure a
  // shape-only schema check would wave through.
  const bodyHigh = Math.max(bar.open, bar.close);
  const bodyLow = Math.min(bar.open, bar.close);
  if (bar.high < bodyHigh || bar.low > bodyLow) {
    return {
      code: "ohlc-inconsistent",
      reason:
        `range ${String(bar.low)}–${String(bar.high)} does not contain ` +
        `open ${String(bar.open)} / close ${String(bar.close)}`,
    };
  }

  const width = intervalMs(options.interval);
  if (bar.ts % width !== 0) {
    return {
      code: "ts-not-aligned",
      reason:
        `ts ${String(bar.ts)} is not a multiple of the ${options.interval} ` +
        `bucket width (${String(width)}ms); live aggregation could never ` +
        `produce this bucket`,
    };
  }

  const session = options.session ?? NSE_DEFAULT_SESSION;
  const dateKey = istDateKey(bar.ts);

  if (isWeekendIST(dateKey) || (options.holidays?.has(dateKey) ?? false)) {
    return {
      code: "ts-non-trading-day",
      reason: `ts ${String(bar.ts)} falls on ${dateKey}, not a trading day`,
    };
  }

  // `ts` is the bucket START, so the last valid bar of the day starts strictly
  // before the close — a 5m bucket stamped 15:30 would cover 15:30–15:35, and
  // the exchange was shut for all of it.
  const minute = minuteOfDayIST(bar.ts);
  const openMin = parseHHMM(session.open);
  const closeMin = parseHHMM(session.close);
  if (minute < openMin || minute >= closeMin) {
    return {
      code: "ts-outside-session",
      reason:
        `ts ${String(bar.ts)} is at ${formatMinute(minute)} IST on ${dateKey}, ` +
        `outside the ${session.open}–${session.close} session`,
    };
  }

  return null;
}

function formatMinute(minuteOfDay: number): string {
  const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minutes = String(minuteOfDay % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export interface BarSweepResult<T> {
  accepted: readonly T[];
  rejected: readonly { bar: T; rejection: BarRejection }[];
  /** Bars dropped because an earlier bar in the batch carried the same `ts`. */
  duplicates: readonly T[];
  /** True when the provider returned bars out of ascending `ts` order. */
  outOfOrder: boolean;
}

/**
 * Validate a batch, in the order the provider returned it.
 *
 * Two properties are only visible across a batch and so cannot live in
 * `validateBar`:
 *
 * **Ordering** is reported, not enforced. A provider returning newest-first is
 * a normal convention, not corruption; what matters is that the caller knows
 * before it assumes the last element is the latest bar. Paging code that
 * silently assumed ascending order is a classic way to backfill a range twice
 * and miss the one next to it.
 *
 * **Duplicates** are dropped, first occurrence wins. A repeated `ts` inside one
 * response means the page overlapped itself; keeping both would put two rows
 * in one bucket, and the storage layer's rank-conditional upsert (D3) would
 * then pick between them by write order rather than by provenance.
 */
export function validateBars<T extends RawBar>(
  bars: readonly T[],
  options: BarValidationOptions,
): BarSweepResult<T> {
  const accepted: T[] = [];
  const rejected: { bar: T; rejection: BarRejection }[] = [];
  const duplicates: T[] = [];
  const seen = new Set<number>();
  let outOfOrder = false;
  let previousTs: number | null = null;

  for (const bar of bars) {
    if (previousTs !== null && bar.ts < previousTs) outOfOrder = true;
    previousTs = bar.ts;

    const rejection = validateBar(bar, options);
    if (rejection !== null) {
      rejected.push({ bar, rejection });
      continue;
    }
    // Only sound bars can claim a bucket — otherwise a mangled row would
    // reserve a `ts` and suppress the good bar that follows it.
    if (seen.has(bar.ts)) {
      duplicates.push(bar);
      continue;
    }
    seen.add(bar.ts);
    accepted.push(bar);
  }

  return { accepted, rejected, duplicates, outOfOrder };
}

/**
 * A one-line-per-code summary of what a run refused.
 *
 * Design §5: rejections are a result, not a log line. A backfill that quietly
 * discarded 4% of its bars is worse than one that failed outright, because the
 * gap is only discovered later by a strategy that behaves oddly on one week in
 * March.
 */
export function summarizeRejections(
  rejected: readonly { rejection: BarRejection }[],
  examplesPerCode = 3,
): { code: BarRejectionCode; count: number; examples: string[] }[] {
  const byCode = new Map<
    BarRejectionCode,
    { count: number; examples: string[] }
  >();
  for (const { rejection } of rejected) {
    const entry = byCode.get(rejection.code) ?? { count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < examplesPerCode)
      entry.examples.push(rejection.reason);
    byCode.set(rejection.code, entry);
  }
  return [...byCode.entries()]
    .map(([code, entry]) => ({ code, ...entry }))
    .sort((a, b) => b.count - a.count);
}
