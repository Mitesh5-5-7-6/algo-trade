import { describe, expect, it } from "vitest";
import {
  chunkRange,
  FyersHistoryProvider,
  type FyersHistoryDeps,
} from "./fyers-history.js";
import { HistoryFetchError } from "./history-provider.js";
import { RateLimiter, RateLimitExhaustedError } from "./rate-limiter.js";

/**
 * §6 and §7 of the Phase 1 design, task 1.6.
 *
 * The behaviour worth pinning down here is not "it parses JSON". It is the
 * handful of places where a historical fetch can look successful and be wrong:
 * epoch seconds read as milliseconds, a page boundary that overlaps or skips,
 * a holiday that reports as a failed fetch, and a retry that burns rate-limit
 * budget the live order path shares.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
/** Epoch ms for an IST wall-clock instant (month is 0-based). */
const ist = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MS;

// 2026-01-05 is a Monday.
const OPEN = ist(2026, 0, 5, 9, 15);
const CLOSE = ist(2026, 0, 5, 15, 30);

/** A FYERS row: [epochSECONDS, open, high, low, close, volume]. */
const row = (
  tsMs: number,
  fields: Partial<Record<"o" | "h" | "l" | "c" | "v", number>> = {},
) => [
  tsMs / 1000,
  fields.o ?? 100,
  fields.h ?? 101,
  fields.l ?? 99,
  fields.c ?? 100.5,
  fields.v ?? 1_000,
];

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that replays scripted responses and records what was asked for. */
function scriptedFetch(
  pages: { body?: unknown; status?: number; text?: string }[],
) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    calls.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    if (page === undefined) throw new Error("no scripted page");
    const text =
      page.text ?? JSON.stringify(page.body ?? { s: "ok", candles: [] });
    return Promise.resolve(new Response(text, { status: page.status ?? 200 }));
  };
  return { fetchImpl, calls, callCount: () => calls.length };
}

function provider(
  overrides: Partial<FyersHistoryDeps> & { fetch: typeof globalThis.fetch },
): FyersHistoryProvider {
  return new FyersHistoryProvider({
    appId: "APP-100",
    getToken: () => Promise.resolve("tok"),
    maxDaysPerRequest: 30,
    requestDelayMs: 0,
    now: () => 1_760_000_000_000,
    ...overrides,
  });
}

const request = {
  symbol: "NSE:NIFTY50-INDEX",
  interval: "5m" as const,
  fromTs: OPEN,
  toTs: CLOSE,
};

describe("chunkRange — day-granular pages, oldest first (§7.1)", () => {
  it("returns one page when the window fits", () => {
    expect(chunkRange(OPEN, CLOSE, 30)).toEqual([
      { fromKey: "2026-01-05", toKey: "2026-01-05" },
    ]);
  });

  it("splits a long window into pages of at most the page size", () => {
    // 2026-01-05 through 2026-01-14 inclusive is 10 calendar days.
    const pages = chunkRange(ist(2026, 0, 5, 0, 0), ist(2026, 0, 15, 0, 0), 4);
    expect(pages).toEqual([
      { fromKey: "2026-01-05", toKey: "2026-01-08" },
      { fromKey: "2026-01-09", toKey: "2026-01-12" },
      { fromKey: "2026-01-13", toKey: "2026-01-14" },
    ]);
  });

  /**
   * Pages must abut exactly. A one-day gap silently loses a session; a one-day
   * overlap doubles the request cost and lands duplicate bars in one bucket.
   */
  it("produces pages that abut without gap or overlap", () => {
    const pages = chunkRange(ist(2026, 0, 5, 0, 0), ist(2026, 2, 1, 0, 0), 7);
    for (let i = 1; i < pages.length; i += 1) {
      const previousEnd = Date.parse(`${pages[i - 1]?.toKey ?? ""}T00:00:00Z`);
      const thisStart = Date.parse(`${pages[i]?.fromKey ?? ""}T00:00:00Z`);
      expect(thisStart - previousEnd).toBe(86_400_000);
    }
  });

  /** `toTs` is exclusive, so a window ending at midnight must not pull in that day. */
  it("does not include the day a window ends exactly at", () => {
    const pages = chunkRange(ist(2026, 0, 5, 0, 0), ist(2026, 0, 7, 0, 0), 30);
    expect(pages).toEqual([{ fromKey: "2026-01-05", toKey: "2026-01-06" }]);
  });

  it("yields nothing for an empty or inverted window", () => {
    expect(chunkRange(OPEN, OPEN, 30)).toEqual([]);
    expect(chunkRange(CLOSE, OPEN, 30)).toEqual([]);
  });
});

describe("getHistory — normalization", () => {
  it("converts epoch seconds to milliseconds", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(OPEN)] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]?.ts).toBe(OPEN);
  });

  /**
   * The provenance that makes D3's rank-conditional upsert work. A backfilled
   * bar outranks LIVE_TICK, so it can correct a bar our tick aggregation built
   * from a feed that may have dropped ticks — but only if it is stamped.
   */
  it("stamps every candle BROKER_HISTORICAL with an ingest time", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(OPEN), row(OPEN + 300_000)] } },
    ]);
    const result = await provider({
      fetch: fetchImpl,
      ingestionVersion: 7,
    }).getHistory(request);

    expect(result.candles).toHaveLength(2);
    for (const candle of result.candles) {
      expect(candle.source).toBe("BROKER_HISTORICAL");
      expect(candle.ingestedAt).toBe(1_760_000_000_000);
      expect(candle.ingestionVersion).toBe(7);
      expect(candle.symbol).toBe("NSE:NIFTY50-INDEX");
      expect(candle.interval).toBe("5m");
    }
  });

  it("omits ingestionVersion when none was configured", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(OPEN)] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);
    expect(result.candles[0]).not.toHaveProperty("ingestionVersion");
  });

  it("maps the OHLCV columns in the vendor's order", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: {
          s: "ok",
          candles: [[OPEN / 1000, 100, 110, 95, 105, 4_242]],
        },
      },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles[0]).toMatchObject({
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 4_242,
    });
  });

  it("returns candles ascending by ts even when the vendor sends them reversed", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: {
          s: "ok",
          candles: [row(OPEN + 600_000), row(OPEN + 300_000), row(OPEN)],
        },
      },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles.map((c) => c.ts)).toEqual([
      OPEN,
      OPEN + 300_000,
      OPEN + 600_000,
    ]);
  });

  it("ignores rows that are not six numbers", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: {
          s: "ok",
          candles: [
            row(OPEN),
            [OPEN / 1000, 100],
            "junk",
            null,
            [1, 2, 3, 4, 5, "x"],
          ],
        },
      },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);
    expect(result.candles).toHaveLength(1);
  });

  it("sends the symbol, resolution and date range the caller asked for", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { body: { s: "ok", candles: [] } },
    ]);
    await provider({ fetch: fetchImpl }).getHistory({
      ...request,
      interval: "15m",
    });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("symbol")).toBe("NSE:NIFTY50-INDEX");
    expect(url.searchParams.get("resolution")).toBe("15");
    expect(url.searchParams.get("range_from")).toBe("2026-01-05");
    expect(url.searchParams.get("range_to")).toBe("2026-01-05");
    expect(calls[0]?.headers["Authorization"]).toBe("APP-100:tok");
  });
});

describe("getHistory — the requested window", () => {
  /**
   * The vendor call is day-granular but the window is not, so whole days come
   * back. `fromTs` is inclusive and `toTs` exclusive; a bar stamped exactly at
   * `toTs` belongs to the next request, and counting it twice is how a
   * resumable backfill ends up with duplicates.
   */
  it("keeps fromTs and drops a bar at exactly toTs", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: {
          s: "ok",
          candles: [row(OPEN - 300_000), row(OPEN), row(OPEN + 300_000)],
        },
      },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory({
      ...request,
      toTs: OPEN + 300_000,
    });

    expect(result.candles.map((c) => c.ts)).toEqual([OPEN]);
  });

  /**
   * A bar outside the asked-for window is not a bad bar. Counting it as a
   * rejection would make every single run report look like it had a
   * data-quality problem, and the real rejections would be lost in it.
   */
  it("does not report out-of-window bars as rejections", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(ist(2026, 0, 5, 8, 0)), row(OPEN)] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });
});

describe("getHistory — validation is applied across the whole range", () => {
  it("rejects a mangled bar and reports the raw row with a reason", async () => {
    const bad = [OPEN / 1000 + 300, 100, 1, 99, 100, 5];
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(OPEN), bad] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("high-below-low");
    expect(result.rejected[0]?.raw).toEqual(bad);
    expect(result.rejected[0]?.ts).toBe(OPEN + 300_000);
  });

  /**
   * The cross-page duplicate is the reason the sweep runs once over every
   * page rather than once per page. Two pages that overlap would otherwise
   * each look clean, and both rows would reach the rank-conditional upsert,
   * which would then pick between them by write order rather than provenance.
   */
  it("catches a ts repeated across two pages", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(ist(2026, 0, 5, 9, 15))] } },
      { body: { s: "ok", candles: [row(ist(2026, 0, 5, 9, 15))] } },
    ]);
    const result = await provider({
      fetch: fetchImpl,
      maxDaysPerRequest: 1,
    }).getHistory({
      ...request,
      toTs: ist(2026, 0, 7, 0, 0),
    });

    expect(result.pagesFetched).toBe(2);
    expect(result.candles).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("duplicate");
  });

  it("rejects a bar on a declared holiday, using the configured calendar", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(OPEN)] } },
    ]);
    const result = await provider({
      fetch: fetchImpl,
      holidays: new Set(["2026-01-05"]),
    }).getHistory(request);

    expect(result.candles).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("ts-non-trading-day");
  });

  /**
   * A bar inside the window but off the bucket grid is the one the aggregator
   * could never have produced, so it would sit in storage forever as a bucket
   * no live bar can ever match or supersede.
   */
  it("rejects a bar that is inside the window but off the interval grid", async () => {
    const offGrid = ist(2026, 0, 5, 9, 17);
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(OPEN), row(offGrid)] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles.map((c) => c.ts)).toEqual([OPEN]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("ts-not-aligned");
  });
});

describe("getHistory — no data is not a failure (§6)", () => {
  /**
   * A holiday and a failed fetch both yield zero candles, and only one is a
   * problem. Collapsing them turns every Diwali into an alert and loses a
   * genuinely missing session in the noise.
   */
  it("reports empty when the vendor says no_data", async () => {
    const { fetchImpl } = scriptedFetch([{ body: { s: "no_data" } }]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.empty).toBe(true);
    expect(result.candles).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("reports empty when the vendor returns ok with no candles", async () => {
    const { fetchImpl } = scriptedFetch([{ body: { s: "ok", candles: [] } }]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);
    expect(result.empty).toBe(true);
  });

  it("is not empty when bars arrived", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(OPEN)] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);
    expect(result.empty).toBe(false);
  });

  /**
   * Bars that arrived and were all refused is a data-quality problem, not an
   * absent session. Reporting it as `empty` would hide the rejections behind
   * "the exchange was shut".
   */
  it("is not empty when every bar that arrived was rejected", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [[OPEN / 1000, 100, 1, 99, 100, 5]] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.empty).toBe(false);
    expect(result.rejected).toHaveLength(1);
  });
});

describe("getHistory — failure (§7.3)", () => {
  it("throws, rather than returning empty, on an HTTP error", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 500, body: { s: "error", message: "upstream" } },
    ]);
    await expect(
      provider({ fetch: fetchImpl, maxRetries: 0 }).getHistory(request),
    ).rejects.toBeInstanceOf(HistoryFetchError);
  });

  it("does not retry an authentication failure", async () => {
    const { fetchImpl, callCount } = scriptedFetch([
      { status: 401, body: { s: "error", message: "token expired" } },
    ]);
    await expect(
      provider({ fetch: fetchImpl, maxRetries: 3 }).getHistory(request),
    ).rejects.toMatchObject({ retryable: false, status: 401 });
    expect(callCount()).toBe(1);
  });

  it("does not retry a malformed request", async () => {
    const { fetchImpl, callCount } = scriptedFetch([
      { status: 400, body: { s: "error", message: "bad symbol" } },
    ]);
    await expect(
      provider({ fetch: fetchImpl, maxRetries: 3 }).getHistory(request),
    ).rejects.toMatchObject({ retryable: false });
    expect(callCount()).toBe(1);
  });

  it("retries a rate-limit response, but a bounded number of times", async () => {
    const { fetchImpl, callCount } = scriptedFetch([
      { status: 429, body: { s: "error", message: "slow down" } },
    ]);
    await expect(
      provider({ fetch: fetchImpl, maxRetries: 2 }).getHistory(request),
    ).rejects.toMatchObject({ status: 429 });
    expect(callCount()).toBe(3);
  });

  it("recovers when a retry succeeds", async () => {
    const { fetchImpl, callCount } = scriptedFetch([
      { status: 503, body: { s: "error", message: "unavailable" } },
      { body: { s: "ok", candles: [row(OPEN)] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(callCount()).toBe(2);
    expect(result.candles).toHaveLength(1);
    // The successful attempt is the page; the failed one is not counted twice.
    expect(result.pagesFetched).toBe(1);
  });

  it("retries a transport error", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
      return Promise.resolve(
        new Response(JSON.stringify({ s: "ok", candles: [row(OPEN)] })),
      );
    };
    const result = await provider({ fetch: fetchImpl }).getHistory(request);
    expect(calls).toBe(2);
    expect(result.candles).toHaveLength(1);
  });

  it("throws on a body that is not JSON", async () => {
    const { fetchImpl } = scriptedFetch([{ text: "<html>gateway</html>" }]);
    await expect(
      provider({ fetch: fetchImpl, maxRetries: 0 }).getHistory(request),
    ).rejects.toThrow(/not JSON/);
  });

  /** FYERS can answer HTTP 200 with its own error status in the body. */
  it("throws when the vendor reports an error on an HTTP 200", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "error", message: "invalid resolution" } },
    ]);
    await expect(
      provider({ fetch: fetchImpl }).getHistory(request),
    ).rejects.toThrow(/invalid resolution/);
  });

  it("fails without a network call when there is no token", async () => {
    const { fetchImpl, callCount } = scriptedFetch([{ body: { s: "ok" } }]);
    await expect(
      provider({
        fetch: fetchImpl,
        getToken: () => Promise.resolve(null),
      }).getHistory(request),
    ).rejects.toMatchObject({ retryable: false });
    expect(callCount()).toBe(0);
  });
});

describe("getHistory — rate-limit discipline (§7.2, overridden)", () => {
  /**
   * Issuing pages concurrently is how a historical run costs a real entry
   * its fill — the vendor limit is per account, so two local limiters still
   * meet there. Sequential is the shape that leaves headroom.
   */
  it("issues pages sequentially, never concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response(JSON.stringify({ s: "ok", candles: [] }));
    };

    await provider({ fetch: fetchImpl, maxDaysPerRequest: 1 }).getHistory({
      ...request,
      toTs: ist(2026, 0, 9, 0, 0),
    });
    expect(maxInFlight).toBe(1);
  });

  it("waits between pages, but not before the first", async () => {
    const waits: number[] = [];
    const { fetchImpl } = scriptedFetch([{ body: { s: "ok", candles: [] } }]);
    await provider({
      fetch: fetchImpl,
      maxDaysPerRequest: 1,
      requestDelayMs: 250,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    }).getHistory({ ...request, toTs: ist(2026, 0, 8, 0, 0) });

    expect(waits).toEqual([250, 250]);
  });

  /**
   * The override of §7.2. The backfill's limiter is its own instance, so
   * exhausting it cannot make the live order path wait — under a shared
   * limiter the backfill's four-thousandth call and a real exit order
   * contend for one token, and arrival order decides which loses.
   */
  it("meters every attempt through its own limiter", async () => {
    let metered = 0;
    const limiter = new RateLimiter({
      minIntervalMs: 0,
      sleep: () => Promise.resolve(),
    });
    const { fetchImpl } = scriptedFetch([{ body: { s: "ok", candles: [] } }]);
    const counting = new Proxy(limiter, {
      get(target, key, receiver) {
        if (key === "run") {
          return <T>(fn: () => Promise<T>): Promise<T> => {
            metered += 1;
            return target.run(fn);
          };
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    await provider({
      fetch: fetchImpl,
      maxDaysPerRequest: 1,
      rateLimiter: counting,
    }).getHistory({ ...request, toTs: ist(2026, 0, 8, 0, 0) });

    expect(metered).toBe(3);
    expect(limiter.callsMade).toBe(3);
  });

  /**
   * A job that would spend the whole account allowance overnight must stop
   * and say so, rather than arriving at the open with nothing left for
   * trading.
   */
  it("stops when its own call ceiling is reached", async () => {
    const limiter = new RateLimiter({
      minIntervalMs: 0,
      maxCalls: 2,
      sleep: () => Promise.resolve(),
    });
    const { fetchImpl } = scriptedFetch([{ body: { s: "ok", candles: [] } }]);

    await expect(
      provider({
        fetch: fetchImpl,
        maxDaysPerRequest: 1,
        maxRetries: 0,
        rateLimiter: limiter,
      }).getHistory({ ...request, toTs: ist(2026, 0, 9, 0, 0) }),
    ).rejects.toBeInstanceOf(RateLimitExhaustedError);
    expect(limiter.callsMade).toBe(2);
  });

  it("runs unmetered, but still spaced, when given no limiter", async () => {
    const waits: number[] = [];
    const { fetchImpl } = scriptedFetch([{ body: { s: "ok", candles: [] } }]);
    const result = await provider({
      fetch: fetchImpl,
      maxDaysPerRequest: 1,
      requestDelayMs: 100,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    }).getHistory({ ...request, toTs: ist(2026, 0, 8, 0, 0) });

    expect(result.pagesFetched).toBe(3);
    expect(waits).toEqual([100, 100]);
  });
});

describe("construction refuses an unmeasured page size (§3.1 Q1)", () => {
  /**
   * FYERS may truncate a too-long range silently and still answer `s: "ok"`,
   * so a guessed page size produces a run that looks successful and a dataset
   * that is quietly short. There is no safe default; task 1.8 measures it.
   */
  it.each([0, -1, 1.5, Number.NaN])("rejects maxDaysPerRequest %s", (value) => {
    expect(
      () =>
        new FyersHistoryProvider({
          appId: "APP-100",
          getToken: () => Promise.resolve("tok"),
          maxDaysPerRequest: value,
          requestDelayMs: 0,
        }),
    ).toThrow(/maxDaysPerRequest/);
  });

  it("rejects a negative inter-call delay", () => {
    expect(
      () =>
        new FyersHistoryProvider({
          appId: "APP-100",
          getToken: () => Promise.resolve("tok"),
          maxDaysPerRequest: 30,
          requestDelayMs: -1,
        }),
    ).toThrow(/requestDelayMs/);
  });
});

describe("getHistory — coverage, so a partial response cannot pass silently", () => {
  /**
   * The failure this exists for: FYERS caps a range it considers too long,
   * returns the first N days, and still answers `s: "ok"`. Nothing throws,
   * the run reports success, and the dataset is short forever.
   */
  it("flags a response that stops before the end of the window", async () => {
    // Ask Mon–Fri; the vendor answers with Mon–Tue only.
    const { fetchImpl } = scriptedFetch([
      {
        body: {
          s: "ok",
          candles: [row(ist(2026, 0, 5, 9, 15)), row(ist(2026, 0, 6, 9, 15))],
        },
      },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory({
      ...request,
      fromTs: ist(2026, 0, 5, 0, 0),
      toTs: ist(2026, 0, 10, 0, 0),
    });

    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.coveredDays).toEqual(["2026-01-05", "2026-01-06"]);
    expect(result.coverage.missingDays).toEqual([
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
    ]);
  });

  it("does not flag a fully covered window", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: {
          s: "ok",
          candles: [row(ist(2026, 0, 5, 9, 15)), row(ist(2026, 0, 6, 9, 15))],
        },
      },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory({
      ...request,
      fromTs: ist(2026, 0, 5, 0, 0),
      toTs: ist(2026, 0, 7, 0, 0),
    });

    expect(result.coverage.truncated).toBe(false);
    expect(result.coverage.missingDays).toEqual([]);
  });

  /**
   * A hole in the middle is not a cap. A provider that truncates returns a
   * contiguous prefix; a scattered gap means something else — an unlisted
   * holiday, or a genuine absence — and merging the two would send an
   * operator looking for the wrong problem.
   */
  it("reports a middle gap as missing without calling it truncation", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: {
          s: "ok",
          candles: [row(ist(2026, 0, 5, 9, 15)), row(ist(2026, 0, 9, 9, 15))],
        },
      },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory({
      ...request,
      fromTs: ist(2026, 0, 5, 0, 0),
      toTs: ist(2026, 0, 10, 0, 0),
    });

    expect(result.coverage.truncated).toBe(false);
    expect(result.coverage.missingDays).toEqual([
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
    ]);
  });

  it("counts trading days only, so a weekend is not a gap", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(ist(2026, 0, 9, 9, 15))] } },
    ]);
    // Fri 2026-01-09 through Sun 2026-01-11.
    const result = await provider({ fetch: fetchImpl }).getHistory({
      ...request,
      fromTs: ist(2026, 0, 9, 0, 0),
      toTs: ist(2026, 0, 12, 0, 0),
    });

    expect(result.coverage.requestedDays).toEqual(["2026-01-09"]);
    expect(result.coverage.missingDays).toEqual([]);
    expect(result.coverage.truncated).toBe(false);
  });

  it("excludes declared holidays from what was requested", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(ist(2026, 0, 5, 9, 15))] } },
    ]);
    const result = await provider({
      fetch: fetchImpl,
      holidays: new Set(["2026-01-06"]),
    }).getHistory({
      ...request,
      fromTs: ist(2026, 0, 5, 0, 0),
      toTs: ist(2026, 0, 7, 0, 0),
    });

    expect(result.coverage.requestedDays).toEqual(["2026-01-05"]);
    expect(result.coverage.truncated).toBe(false);
  });

  /**
   * An entirely empty range is `empty`, not truncation. Calling it a cap
   * would flag every closed period as a vendor problem.
   */
  it("does not call a wholly empty response truncated", async () => {
    const { fetchImpl } = scriptedFetch([{ body: { s: "no_data" } }]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.empty).toBe(true);
    expect(result.coverage.truncated).toBe(false);
  });
});

describe("getHistory — volume is optional for an index", () => {
  /**
   * An index has no tradeable volume of its own. Rejecting the bar for a
   * missing volume column would discard a sound OHLC record over a field
   * that instrument was never going to have — and rejecting every index bar
   * is a data outage, not a validation rule.
   */
  it("keeps a bar whose volume column is absent", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [[OPEN / 1000, 100, 101, 99, 100.5]] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.rejected).toEqual([]);
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]?.volume).toBe(0);
    expect(result.candles[0]?.volumeAvailable).toBe(false);
    expect(result.candles[0]?.volumeQuality).toBe("UNAVAILABLE");
  });

  it("keeps a bar whose volume is null", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: { s: "ok", candles: [[OPEN / 1000, 100, 101, 99, 100.5, null]] },
      },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]?.volumeAvailable).toBe(false);
  });

  /**
   * Zero is NOT assumed to mean unavailable. Whether an NSE index reports
   * real volume is §3.1 Q4, unmeasured — so the bar is marked SUSPECT,
   * which says "do not build on this" without claiming to know why.
   */
  it("marks an unverified zero SUSPECT rather than guessing", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [[OPEN / 1000, 100, 101, 99, 100.5, 0]] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles[0]?.volume).toBe(0);
    expect(result.candles[0]?.volumeQuality).toBe("SUSPECT");
  });

  it("marks zero UNAVAILABLE once Q4 has confirmed it", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [[OPEN / 1000, 100, 101, 99, 100.5, 0]] } },
    ]);
    const result = await provider({
      fetch: fetchImpl,
      zeroVolumeIsUnavailable: true,
    }).getHistory(request);

    expect(result.candles[0]?.volumeAvailable).toBe(false);
    expect(result.candles[0]?.volumeQuality).toBe("UNAVAILABLE");
  });

  it("marks volume REAL for a symbol known to have it", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [row(OPEN, { v: 4242 })] } },
    ]);
    const result = await provider({
      fetch: fetchImpl,
      symbolHasRealVolume: true,
    }).getHistory(request);

    expect(result.candles[0]?.volume).toBe(4242);
    expect(result.candles[0]?.volumeAvailable).toBe(true);
    expect(result.candles[0]?.volumeQuality).toBe("REAL");
  });

  /** A negative volume is still corrupt — optional is not unchecked. */
  it("still rejects a negative volume", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [[OPEN / 1000, 100, 101, 99, 100.5, -5]] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);

    expect(result.candles).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("volume-negative");
  });

  it("still rejects a row missing a price column", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { s: "ok", candles: [[OPEN / 1000, 100, 101, 99]] } },
    ]);
    const result = await provider({ fetch: fetchImpl }).getHistory(request);
    expect(result.candles).toEqual([]);
  });
});
