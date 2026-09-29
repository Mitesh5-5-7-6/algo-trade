import {
  istDateKey,
  startOfDayIST,
  tradingDaysBetween,
  validateBars,
  type Candle,
  type CandleInterval,
  type RawBar,
  type SessionConfig,
  type VolumeQuality,
} from "@neelkanth/core";
import { RateLimiter, RateLimitExhaustedError } from "./rate-limiter.js";
import {
  HistoryFetchError,
  type HistoryCoverage,
  type HistoryProvider,
  type HistoryRejection,
  type HistoryRequest,
  type HistoryResult,
} from "./history-provider.js";

/**
 * The FYERS History API as a `HistoryProvider` (design D1, §7, task 1.6).
 *
 * Kept out of `fyers-broker.ts` so paging, normalization and retry can be
 * tested without standing up a broker, two websockets and an order path.
 * `FyersBroker` delegates to it, so `FyersBroker implements HistoryProvider`
 * still holds and the composition root has one thing to wire.
 *
 * Vendor behaviour here is MEASURED, not assumed — §3.1, task 1.8, probed
 * 2026-09-28:
 *
 *   - a range over the cap returns **HTTP 422** with no body, rejecting the
 *     whole request. It does not truncate silently, which is the kinder of
 *     the two failure modes — but `coverage` still checks, because that is a
 *     vendor promise rather than a guarantee.
 *   - a non-trading day returns **HTTP 200 with `s: "no_data"`** and an empty
 *     `candles` array. A closed market is a SUCCESSFUL response, which is
 *     what lets a transport failure be told apart from a holiday without a
 *     heuristic.
 *   - index symbols return **real, non-zero volume**, contrary to the common
 *     claim, so volume is not discarded for indices.
 *
 * The page size stays a required dependency even though the cap is now known:
 * a measured number recorded in a document is not the same as one hard-coded
 * into the fetch path, and the vendor can change it without telling anyone.
 */

const HISTORY_URL = "https://api-t1.fyers.in/data/history";
const DAY_MS = 86_400_000;

/** FYERS resolution codes, keyed by our interval. */
const RESOLUTION: Record<CandleInterval, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "60m": "60",
};

export interface FyersHistoryDeps {
  appId: string;
  getToken: () => Promise<string | null>;
  /**
   * The backfill's OWN limiter, never the live order path's.
   *
   * Design §7.2 accepted a shared budget through
   * `FyersBrokerDeps.checkRateLimit`; that is overridden. A shared
   * limiter makes the backfill's four-thousandth call and a real exit
   * order contend for one token, decided by arrival order — and the
   * backfill losing costs a retry while the exit losing costs money.
   *
   * Supply a `RateLimiter` built for this job alone. Omitted, the
   * provider still spaces its calls by `requestDelayMs`, but nothing
   * caps the total.
   */
  rateLimiter?: RateLimiter;
  /**
   * Maximum days per request (§3.1 question 1).
   *
   * **Required, with no default.** The cap is a measured vendor fact, not a
   * preference. A guess that is too large is the worst outcome available here:
   * FYERS may truncate silently and still answer `s: "ok"`, so the run looks
   * successful and the dataset is quietly short. Task 1.8 measures it; until
   * then nothing can construct this provider by accident.
   */
  maxDaysPerRequest: number;
  /** Fixed delay between sequential calls, ms (§7.2). */
  requestDelayMs: number;
  /** Exchange holidays, so ingestion and the live session agree (§5). */
  holidays?: ReadonlySet<string>;
  /** Weekend dates the exchange traded anyway (Budget, Muhurat). */
  specialSessions?: ReadonlySet<string>;
  /** Session window bars are validated against. Defaults to NSE. */
  session?: SessionConfig;
  /**
   * Treat a zero volume as unavailable rather than as a real zero.
   *
   * Defaults to false, and deliberately has no cleverness behind it:
   * whether an NSE index reports real volume is §3.1 Q4, unmeasured.
   * Until it is answered an index bar's zero is marked SUSPECT, which
   * says "do not build on this" without claiming to know why. Set this
   * true for index symbols once Q4 confirms the column is meaningless.
   */
  zeroVolumeIsUnavailable?: boolean;
  /**
   * Whether this symbol has tradeable volume at all. Index symbols do
   * not; an equity does. Absent means unknown, which is marked SUSPECT
   * rather than guessed either way.
   */
  symbolHasRealVolume?: boolean;
  /** Bounded retry on transport errors (§7.3). Default 2 extra attempts. */
  maxRetries?: number;
  /** Stamped on every candle, so a distrusted run can be identified later. */
  ingestionVersion?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface FyersHistoryBody {
  s?: string;
  message?: string;
  /** `[epochSeconds, open, high, low, close, volume?]` per row. */
  candles?: unknown;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class FyersHistoryProvider implements HistoryProvider {
  private readonly deps: FyersHistoryDeps;

  constructor(deps: FyersHistoryDeps) {
    if (!Number.isInteger(deps.maxDaysPerRequest) || deps.maxDaysPerRequest < 1)
      throw new Error("maxDaysPerRequest must be a positive integer (§3.1 Q1)");
    if (!Number.isFinite(deps.requestDelayMs) || deps.requestDelayMs < 0)
      throw new Error("requestDelayMs must be a non-negative number");
    this.deps = deps;
  }

  async getHistory(req: HistoryRequest): Promise<HistoryResult> {
    const pages = chunkRange(req.fromTs, req.toTs, this.deps.maxDaysPerRequest);

    const rows: (number | null)[][] = [];
    let pagesFetched = 0;
    let sawNoData = false;

    // Sequential, never concurrent, oldest first (§7.1, §7.2): a partial run
    // then leaves a contiguous prefix of history rather than a scatter of
    // fragments, and a re-run resumes cleanly.
    for (const [index, page] of pages.entries()) {
      if (index > 0) await this.pause();
      const body = await this.fetchPage(req, page);
      pagesFetched += 1;
      if (body.s === "no_data") sawNoData = true;
      rows.push(...parseRows(body.candles));
    }

    // Requests are day-granular but the window is not, so the vendor answers
    // with whole days. Trim before validating: a bar outside the asked-for
    // window is not a bad bar, and counting it as a rejection would make every
    // run report look like it had a data-quality problem.
    const inWindow = rows.filter((row) => {
      const ts = (row[0] ?? Number.NaN) * 1000;
      return ts >= req.fromTs && ts < req.toTs;
    });

    // One sweep across every page, not one per page — a `ts` repeated because
    // two pages overlapped is precisely the duplicate worth catching, and a
    // per-page sweep is blind to it.
    const sweep = validateBars(inWindow.map(toRawBar), {
      interval: req.interval,
      ...(this.deps.holidays === undefined
        ? {}
        : { holidays: this.deps.holidays }),
      ...(this.deps.specialSessions === undefined
        ? {}
        : { specialSessions: this.deps.specialSessions }),
      ...(this.deps.session === undefined
        ? {}
        : { session: this.deps.session }),
    });

    const ingestedAt = (this.deps.now ?? Date.now)();
    const candles: Candle[] = sweep.accepted
      .map((bar) => this.toCandle(bar, req, ingestedAt))
      .sort((a, b) => a.ts - b.ts);

    const coverage = this.coverageOf(req, candles);

    const rejected: HistoryRejection[] = [
      ...sweep.rejected.map(({ bar, rejection }) => ({
        ts: bar.ts,
        reason: `${rejection.code}: ${rejection.reason}`,
        raw: bar.raw,
      })),
      ...sweep.duplicates.map((bar) => ({
        ts: bar.ts,
        reason: `duplicate: a bar for ${String(bar.ts)} already arrived in this range`,
        raw: bar.raw,
      })),
    ];

    return {
      candles,
      coverage,
      rejected,
      // "No bars, and the vendor said so" — not "no bars, and something broke".
      // A transport failure never reaches here; it throws.
      empty: candles.length === 0 && (sawNoData || rows.length === 0),
      pagesFetched,
    };
  }

  private toCandle(
    bar: RawBar,
    req: HistoryRequest,
    ingestedAt: number,
  ): Candle {
    return {
      symbol: req.symbol,
      interval: req.interval,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      ...this.volumeFacts(bar.volume),
      ts: bar.ts,
      // The exchange's own consolidated record — outranks LIVE_TICK, so the
      // rank-conditional upsert (D3) lets a backfill correct a bar our tick
      // aggregation built from a feed that may have dropped ticks.
      source: "BROKER_HISTORICAL",
      ingestedAt,
      ...(this.deps.ingestionVersion === undefined
        ? {}
        : { ingestionVersion: this.deps.ingestionVersion }),
    };
  }

  /**
   * Measure what came back against what was asked for.
   *
   * Trading days, not calendar days: a window over a long weekend is not
   * short because Saturday produced nothing. The calendar is the same one
   * the live session uses, so ingestion and trading cannot disagree about
   * which days were supposed to exist.
   */
  private coverageOf(
    req: HistoryRequest,
    candles: readonly Candle[],
  ): HistoryCoverage {
    const holidays = this.deps.holidays ?? new Set<string>();
    // `toTs` is exclusive, so the last instant the window contains is
    // toTs - 1; passing toTs would count a day the caller excluded.
    const requestedDays = tradingDaysBetween(
      req.fromTs,
      req.toTs - 1,
      holidays,
      this.deps.specialSessions ?? new Set<string>(),
    );
    const covered = new Set(candles.map((c) => istDateKey(c.ts)));
    const coveredDays = requestedDays.filter((day) => covered.has(day));
    const missingDays = requestedDays.filter((day) => !covered.has(day));

    // Truncation is a CONTIGUOUS TAIL of missing days. A provider that
    // caps a range returns a prefix and stops; scattered gaps are a
    // different fact and are reported as missingDays alone.
    let tail = 0;
    for (let i = requestedDays.length - 1; i >= 0; i -= 1) {
      const day = requestedDays[i];
      if (day === undefined || covered.has(day)) break;
      tail += 1;
    }
    // Every day missing means an empty response, which is `empty` — not a
    // cap. Calling that truncation would flag every holiday-only range.
    const truncated = tail > 0 && tail < requestedDays.length;

    return {
      requestedFrom: req.fromTs,
      requestedTo: req.toTs,
      requestedDays,
      coveredDays,
      missingDays,
      truncated,
    };
  }

  /**
   * Decide what a bar's volume is worth, without inventing any of it.
   *
   * Three honest outcomes and no fourth: the source gave none
   * (UNAVAILABLE), the source gave a number we have reason to trust
   * (REAL), or the source gave a number whose meaning is unconfirmed
   * (SUSPECT). An index zero before §3.1 Q4 is answered is SUSPECT — not
   * REAL, because nobody has checked, and not UNAVAILABLE, because that
   * would assert a measurement nobody made.
   */
  private volumeFacts(raw: number | null): {
    volume: number;
    volumeAvailable?: boolean;
    volumeQuality?: VolumeQuality;
    volumeSource?: string;
  } {
    if (raw === null)
      return {
        volume: 0,
        volumeAvailable: false,
        volumeQuality: "UNAVAILABLE",
        volumeSource: "BROKER_HISTORICAL",
      };

    if (raw === 0 && this.deps.zeroVolumeIsUnavailable === true)
      return {
        volume: 0,
        volumeAvailable: false,
        volumeQuality: "UNAVAILABLE",
        volumeSource: "BROKER_HISTORICAL",
      };

    if (this.deps.symbolHasRealVolume === true)
      return {
        volume: raw,
        volumeAvailable: true,
        volumeQuality: "REAL",
        volumeSource: "BROKER_HISTORICAL",
      };

    if (this.deps.symbolHasRealVolume === false)
      return {
        volume: raw,
        volumeAvailable: false,
        volumeQuality: "UNAVAILABLE",
        volumeSource: "BROKER_HISTORICAL",
      };

    return {
      volume: raw,
      volumeAvailable: true,
      volumeQuality: "SUSPECT",
      volumeSource: "BROKER_HISTORICAL",
    };
  }

  private async pause(): Promise<void> {
    if (this.deps.requestDelayMs <= 0) return;
    await (this.deps.sleep ?? defaultSleep)(this.deps.requestDelayMs);
  }

  private async fetchPage(
    req: HistoryRequest,
    page: { fromKey: string; toKey: string },
  ): Promise<FyersHistoryBody> {
    const attempts = 1 + (this.deps.maxRetries ?? 2);
    let lastError: HistoryFetchError | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.requestOnce(req, page);
      } catch (error) {
        // An exhausted budget is not a transport hiccup. Retrying it spins
        // against a limiter that will never yield, and each attempt is another
        // call the account cannot afford.
        if (error instanceof RateLimitExhaustedError) throw error;
        const fetchError =
          error instanceof HistoryFetchError
            ? error
            : new HistoryFetchError((error as Error).message, {
                retryable: true,
                cause: error,
              });
        // An expired token or a malformed request will not improve by
        // repetition, and every retry spends rate-limit budget the live order
        // path shares (§7.2, §7.3).
        if (!fetchError.retryable) throw fetchError;
        lastError = fetchError;
        if (attempt < attempts) await this.pause();
      }
    }
    throw (
      lastError ??
      new HistoryFetchError("history fetch failed", {
        retryable: true,
      })
    );
  }

  private async requestOnce(
    req: HistoryRequest,
    page: { fromKey: string; toKey: string },
  ): Promise<FyersHistoryBody> {
    const limiter = this.deps.rateLimiter;
    if (limiter === undefined) return this.sendRequest(req, page);
    // The limiter wraps the network call itself, so its interval measures
    // request starts rather than the gaps between them. A limiter that
    // only guarded the caller would drift by however long each call took.
    return limiter.run(() => this.sendRequest(req, page));
  }

  private async sendRequest(
    req: HistoryRequest,
    page: { fromKey: string; toKey: string },
  ): Promise<FyersHistoryBody> {
    const token = await this.deps.getToken();
    if (token === null || token === "")
      throw new HistoryFetchError("no FYERS access token available", {
        retryable: false,
      });

    const url = `${HISTORY_URL}?${new URLSearchParams({
      symbol: req.symbol,
      resolution: RESOLUTION[req.interval],
      date_format: "1",
      range_from: page.fromKey,
      range_to: page.toKey,
      cont_flag: "1",
    }).toString()}`;

    const doFetch = this.deps.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: {
          Authorization: `${this.deps.appId}:${token}`,
          version: "3",
        },
      });
    } catch (error) {
      throw new HistoryFetchError(
        `history request failed: ${(error as Error).message}`,
        { retryable: true, cause: error },
      );
    }

    const text = await response.text();
    let body: FyersHistoryBody = {};
    let parsed = true;
    try {
      body = JSON.parse(text) as FyersHistoryBody;
    } catch {
      parsed = false;
    }

    // Order matters. The measured 422 for an over-long range comes back with
    // an EMPTY body, so parsing first and reporting "not JSON" would bury the
    // one diagnosis that names the fix. A non-2xx is classified by its status;
    // an unreadable body is only a story of its own when the request
    // otherwise succeeded.
    if (response.ok && !parsed) {
      throw new HistoryFetchError(
        `history response was not JSON (HTTP ${String(response.status)}): ${text.slice(0, 200)}`,
        { retryable: false, status: response.status },
      );
    }

    if (!response.ok) {
      // 422 is the measured response to an over-long range (§3.1 Q1: 100 days
      // succeed, 150 returns 422 with no body). Worth naming, because the
      // generic message would send an operator looking at credentials or the
      // network when the fix is one number. The vendor gives no hint of its
      // own — no message, no documented code — so the interpretation has to
      // come from here.
      if (response.status === 422) {
        throw new HistoryFetchError(
          `history request refused as too large (HTTP 422) for ` +
            `${page.fromKey}..${page.toKey} at ${String(this.deps.maxDaysPerRequest)} ` +
            `days per request. The measured cap is 100 days (§3.1 Q1) — lower ` +
            `maxDaysPerRequest. Nothing was truncated; the range was rejected ` +
            `outright.`,
          { retryable: false, status: 422 },
        );
      }
      throw new HistoryFetchError(
        `history request rejected (HTTP ${String(response.status)}): ${body.message ?? "no message"}`,
        {
          // 401/403 is a token problem and 400 a request problem; neither is
          // fixed by asking again. 429 and 5xx are worth one more try.
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
        },
      );
    }

    // `s` is FYERS' own status and can say "error" on an HTTP 200.
    if (body.s !== undefined && body.s !== "ok" && body.s !== "no_data") {
      throw new HistoryFetchError(
        `history request returned s=${body.s}: ${body.message ?? "no message"}`,
        { retryable: false, status: response.status },
      );
    }
    return body;
  }
}

/** A row is `[epochSeconds, o, h, l, c, v]`; anything else is not a bar. */
function parseRows(candles: unknown): (number | null)[][] {
  if (!Array.isArray(candles)) return [];
  return candles.filter(
    (row): row is (number | null)[] =>
      Array.isArray(row) &&
      // Five columns is a complete bar; the sixth, volume, is optional
      // because an index may not have one. Discarding those rows would
      // throw away sound OHLC over a field the instrument never had.
      row.length >= 5 &&
      row.slice(0, 5).every((v) => typeof v === "number") &&
      (row.length < 6 || row[5] === null || typeof row[5] === "number"),
  );
}

interface RawFyersBar extends RawBar {
  raw: readonly (number | null)[];
}

function toRawBar(row: (number | null)[]): RawFyersBar {
  // FYERS timestamps are epoch SECONDS. A missing multiplication here would
  // put every bar in 1970, which the alignment and session checks catch — but
  // the raw row is carried through so the report can show what arrived.
  return {
    ts: (row[0] ?? Number.NaN) * 1000,
    open: row[1] ?? Number.NaN,
    high: row[2] ?? Number.NaN,
    low: row[3] ?? Number.NaN,
    close: row[4] ?? Number.NaN,
    // `?? null`, never `?? NaN`: an absent volume is a statement about
    // the instrument, not a corrupt bar, and NaN here would reject every
    // index candle as non-finite.
    volume: row[5] ?? null,
    raw: row,
  };
}

/**
 * Split a half-open `[fromTs, toTs)` window into day-granular request pages,
 * oldest first (§7.1).
 *
 * Pages are whole IST days because the vendor call is day-granular
 * (`date_format: "1"`). The caller's exact window is applied afterwards by
 * filtering, so a window that starts mid-session still returns only the bars
 * it asked for.
 */
export function chunkRange(
  fromTs: number,
  toTs: number,
  maxDaysPerRequest: number,
): { fromKey: string; toKey: string }[] {
  const pages: { fromKey: string; toKey: string }[] = [];
  if (toTs <= fromTs) return pages;

  const span = maxDaysPerRequest * DAY_MS;
  // The last day the window touches: `toTs` is exclusive, so a window ending
  // exactly at an IST midnight must not pull in the day that begins there.
  const lastDay = startOfDayIST(toTs - 1);

  for (let day = startOfDayIST(fromTs); day <= lastDay; day += span) {
    const pageEnd = Math.min(day + span - DAY_MS, lastDay);
    pages.push({ fromKey: istDateKey(day), toKey: istDateKey(pageEnd) });
  }
  return pages;
}
