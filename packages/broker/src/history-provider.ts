import type { BarRejection, Candle, CandleInterval } from "@neelkanth/core";

/**
 * Historical bar retrieval (docs/design/PHASE_1_HISTORICAL_DATA.md D1, task 1.6).
 *
 * This is deliberately NOT a method on `Broker`. That contract has two duties —
 * execution and the realtime feed — and each has a named consumer. Historical
 * fetch has neither: the Order Manager and the Market Data Engine never call
 * it. Widening `Broker` would force `PaperBroker` and `ScriptedFakeBroker` to
 * implement a method they cannot meaningfully answer, and the honest
 * implementations would be a throw and a stub.
 *
 * A capability interface keeps `Broker` truthful and lets the backfill job
 * depend on exactly what it needs. The composition root supplies a provider
 * only where a real one exists; the job requires a non-null provider and
 * refuses to start without one, rather than silently producing nothing.
 */

export interface HistoryRequest {
  symbol: string;
  interval: CandleInterval;
  /** Inclusive, epoch ms. */
  fromTs: number;
  /** Exclusive, epoch ms. */
  toTs: number;
}

export interface HistoryRejection {
  ts: number;
  reason: string;
  /**
   * The provider row exactly as it arrived, for the run report.
   *
   * Nullable entries: a source may omit the volume column, and the report
   * should show what arrived rather than a coerced stand-in.
   */
  raw: readonly (number | null)[];
}

/**
 * What a response actually covered, against what was asked for.
 *
 * Without this a partial response passes silently, which is the single
 * most dangerous failure in historical ingestion: FYERS may cap a range it
 * considers too long, return the first N days, and still answer `s: "ok"`.
 * Nothing throws. The run reports success. The dataset is short, and every
 * strategy and backtest built on it inherits the gap without a signal.
 */
export interface HistoryCoverage {
  /** The window the caller asked for. */
  requestedFrom: number;
  requestedTo: number;
  /** IST trading days inside that window, per the configured calendar. */
  requestedDays: readonly string[];
  /** IST days at least one accepted bar landed in. */
  coveredDays: readonly string[];
  /** Trading days that were asked for and produced no accepted bar. */
  missingDays: readonly string[];
  /**
   * True when the missing days form an unbroken run at the END of the
   * window.
   *
   * That shape is the signature of a silent cap: a provider that truncates
   * gives back a contiguous prefix. Scattered gaps look different and mean
   * something else — an unlisted holiday, or a genuine hole — so the two
   * are reported separately rather than merged into one `incomplete` flag.
   */
  truncated: boolean;
}

export interface HistoryResult {
  /** Sound bars, ascending by `ts`, already stamped `BROKER_HISTORICAL`. */
  candles: readonly Candle[];
  /** What arrived, measured against what was requested. */
  coverage: HistoryCoverage;
  /** Bars the provider returned but validation refused. */
  rejected: readonly HistoryRejection[];
  /**
   * True when the provider signalled "no data" rather than an error.
   *
   * The distinction is the whole point: a holiday and a failed fetch both
   * yield zero candles, and only one of them is a problem. Collapsing them
   * turns every Diwali into an alert and loses a genuinely missing session in
   * the noise.
   */
  empty: boolean;
  /** How many requests were issued — the paging cost of this range. */
  pagesFetched: number;
}

export interface HistoryProvider {
  getHistory(req: HistoryRequest): Promise<HistoryResult>;
}

/** A transport or vendor failure. Carries whether repeating the call could help. */
export class HistoryFetchError extends Error {
  /**
   * False for authentication and malformed-request failures, which will not
   * improve by repetition (design §7.3). Retrying those only burns the rate
   * limit the live order path shares.
   */
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "HistoryFetchError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/** Reported per rejected bar so a run summary can group by cause. */
export type { BarRejection };
