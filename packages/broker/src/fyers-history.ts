import {
  istDateKey,
  startOfDayIST,
  validateBars,
  type Candle,
  type CandleInterval,
  type RawBar,
  type SessionConfig,
} from "@neelkanth/core";
import {
  HistoryFetchError,
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
 * Vendor-specific behaviour this file deliberately does NOT assume is in
 * §3.1 — the five questions task 1.8 answers with one real call each. The
 * page size is a required dependency for exactly that reason.
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
  /** The same seam the order path uses — a backfill shares its budget (§7.2). */
  checkRateLimit?: () => Promise<void>;
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
  /** Session window bars are validated against. Defaults to NSE. */
  session?: SessionConfig;
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
  /** `[epochSeconds, open, high, low, close, volume]` per row. */
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

    const rows: number[][] = [];
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
      ...(this.deps.session === undefined
        ? {}
        : { session: this.deps.session }),
    });

    const ingestedAt = (this.deps.now ?? Date.now)();
    const candles: Candle[] = sweep.accepted
      .map((bar) => this.toCandle(bar, req, ingestedAt))
      .sort((a, b) => a.ts - b.ts);

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
      volume: bar.volume,
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
    if (this.deps.checkRateLimit) await this.deps.checkRateLimit();

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
    let body: FyersHistoryBody;
    try {
      body = JSON.parse(text) as FyersHistoryBody;
    } catch {
      throw new HistoryFetchError(
        `history response was not JSON (HTTP ${String(response.status)}): ${text.slice(0, 200)}`,
        { retryable: response.status >= 500, status: response.status },
      );
    }

    if (!response.ok) {
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
function parseRows(candles: unknown): number[][] {
  if (!Array.isArray(candles)) return [];
  return candles.filter(
    (row): row is number[] =>
      Array.isArray(row) &&
      row.length >= 6 &&
      row.every((v) => typeof v === "number"),
  );
}

interface RawFyersBar extends RawBar {
  raw: readonly number[];
}

function toRawBar(row: number[]): RawFyersBar {
  // FYERS timestamps are epoch SECONDS. A missing multiplication here would
  // put every bar in 1970, which the alignment and session checks catch — but
  // the raw row is carried through so the report can show what arrived.
  return {
    ts: (row[0] ?? Number.NaN) * 1000,
    open: row[1] ?? Number.NaN,
    high: row[2] ?? Number.NaN,
    low: row[3] ?? Number.NaN,
    close: row[4] ?? Number.NaN,
    volume: row[5] ?? Number.NaN,
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
