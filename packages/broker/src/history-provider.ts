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
  /** The provider's row exactly as it arrived, for the run report. */
  raw: readonly number[];
}

export interface HistoryResult {
  /** Sound bars, ascending by `ts`, already stamped `BROKER_HISTORICAL`. */
  candles: readonly Candle[];
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
