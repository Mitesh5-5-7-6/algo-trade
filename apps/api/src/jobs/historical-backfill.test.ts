import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import type { HistoryProvider, HistoryResult } from "@neelkanth/broker";
import {
  backfillSucceeded,
  formatBackfillReport,
  istMidnight,
  runHistoricalBackfill,
  splitIntoRanges,
  type BackfillDeps,
  type BackfillRequest,
} from "./historical-backfill.js";

/**
 * Task 1.10 — design D6, §7.
 *
 * The job cannot be run against the live API until §3.1 Q1 is measured, so
 * everything here drives a fake provider. That is not a workaround: the parts
 * worth testing — range splitting, per-symbol isolation, what counts as a day
 * with no data, and whether one failed range takes the run down with it — are
 * all vendor-independent by construction.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const ist = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MS;

const SYMBOL_A = "NSE:NIFTY50-INDEX";

const candle = (ts: number, symbol = SYMBOL_A): Candle => ({
  symbol,
  interval: "5m",
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume: 1_000,
  ts,
  source: "BROKER_HISTORICAL",
});

/** Coverage for a result that was asked for nothing in particular. */
const noCoverage = {
  requestedFrom: 0,
  requestedTo: 0,
  requestedDays: [],
  coveredDays: [],
  missingDays: [],
  truncated: false,
};

const emptyResult: HistoryResult = {
  candles: [],
  coverage: noCoverage,
  rejected: [],
  empty: true,
  pagesFetched: 1,
};

/** Records every request and replays scripted results. */
function fakeProvider(
  script: (req: {
    symbol: string;
    fromTs: number;
    toTs: number;
  }) => HistoryResult | Error = () => emptyResult,
) {
  const requests: { symbol: string; fromTs: number; toTs: number }[] = [];
  const provider: HistoryProvider = {
    getHistory: (req) => {
      requests.push({
        symbol: req.symbol,
        fromTs: req.fromTs,
        toTs: req.toTs,
      });
      const result = script(req);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    },
  };
  return { provider, requests };
}

function deps(overrides: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    history: fakeProvider().provider,
    saveCandle: () => Promise.resolve(true),
    holidays: new Set<string>(),
    ...overrides,
  };
}

// 2026-01-05 is a Monday; 2026-01-09 the Friday.
const request: BackfillRequest = {
  symbols: ["NSE:NIFTY50-INDEX"],
  interval: "5m",
  fromDate: "2026-01-05",
  toDate: "2026-01-09",
};

describe("istMidnight", () => {
  it("maps an IST date key to IST midnight in epoch ms", () => {
    expect(istMidnight("2026-01-05")).toBe(ist(2026, 0, 5, 0, 0));
  });

  it.each(["2026-1-5", "05-01-2026", "", "not-a-date"])(
    "rejects the malformed date %s",
    (value) => {
      expect(() => istMidnight(value)).toThrow(/invalid IST date/);
    },
  );

  /**
   * `Date.parse` accepts "2026-02-31" and rolls it forward to March. A range
   * that silently shifted would backfill days nobody asked for and report
   * success.
   */
  it("rejects a date that does not exist rather than rolling it forward", () => {
    expect(() => istMidnight("2026-02-31")).toThrow(/not a real calendar date/);
  });
});

describe("splitIntoRanges", () => {
  it("returns one range when the span fits", () => {
    const ranges = splitIntoRanges(
      istMidnight("2026-01-05"),
      istMidnight("2026-01-09"),
      30,
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      fromDate: "2026-01-05",
      toDate: "2026-01-09",
    });
  });

  it("splits a long span into consecutive chunks, oldest first", () => {
    const ranges = splitIntoRanges(
      istMidnight("2026-01-01"),
      istMidnight("2026-01-10"),
      4,
    );
    expect(ranges.map((r) => [r.fromDate, r.toDate])).toEqual([
      ["2026-01-01", "2026-01-04"],
      ["2026-01-05", "2026-01-08"],
      ["2026-01-09", "2026-01-10"],
    ]);
  });

  it("produces ranges that abut without gap or overlap", () => {
    const ranges = splitIntoRanges(
      istMidnight("2026-01-01"),
      istMidnight("2026-03-31"),
      7,
    );
    for (let i = 1; i < ranges.length; i += 1) {
      expect((ranges[i]?.fromMs ?? 0) - (ranges[i - 1]?.toMs ?? 0)).toBe(
        86_400_000,
      );
    }
  });

  it("yields nothing for an inverted span", () => {
    expect(
      splitIntoRanges(istMidnight("2026-01-09"), istMidnight("2026-01-05"), 30),
    ).toEqual([]);
  });
});

describe("runHistoricalBackfill — refusing to start (D1)", () => {
  /**
   * The whole reason `HistoryProvider` is a capability interface rather than a
   * widening of `Broker`. A job that ran to completion against a stub and
   * reported storing nothing would be indistinguishable from a genuinely
   * empty range.
   */
  it("refuses a null provider instead of reporting an empty run", async () => {
    await expect(
      runHistoricalBackfill(request, deps({ history: null })),
    ).rejects.toThrow(/requires a HistoryProvider/);
  });

  it("refuses an empty symbol list", async () => {
    await expect(
      runHistoricalBackfill({ ...request, symbols: [] }, deps()),
    ).rejects.toThrow(/at least one symbol/);
  });

  it("refuses an inverted date range", async () => {
    await expect(
      runHistoricalBackfill(
        { ...request, fromDate: "2026-01-09", toDate: "2026-01-05" },
        deps(),
      ),
    ).rejects.toThrow(/inverted/);
  });

  it("refuses a non-positive chunk size", async () => {
    await expect(
      runHistoricalBackfill(request, deps({ daysPerRange: 0 })),
    ).rejects.toThrow(/daysPerRange/);
  });
});

describe("runHistoricalBackfill — what it asks for", () => {
  it("asks for a half-open window that includes the last requested day", async () => {
    const { provider, requests } = fakeProvider();
    await runHistoricalBackfill(request, deps({ history: provider }));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.fromTs).toBe(istMidnight("2026-01-05"));
    // Exclusive end: the start of the day AFTER 2026-01-09.
    expect(requests[0]?.toTs).toBe(istMidnight("2026-01-10"));
  });

  it("walks ranges oldest first", async () => {
    const { provider, requests } = fakeProvider();
    await runHistoricalBackfill(
      { ...request, fromDate: "2026-01-05", toDate: "2026-01-30" },
      deps({ history: provider, daysPerRange: 7 }),
    );

    const starts = requests.map((r) => r.fromTs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts.length).toBeGreaterThan(1);
  });

  /**
   * Asking about a range the exchange was shut for spends rate-limit budget to
   * be told nothing happened — budget the live order path shares (§7.2).
   */
  it("skips a range made entirely of weekends and holidays", async () => {
    const { provider, requests } = fakeProvider();
    await runHistoricalBackfill(
      // 2026-01-03 and -04 are the weekend.
      { ...request, fromDate: "2026-01-03", toDate: "2026-01-04" },
      deps({ history: provider }),
    );
    expect(requests).toEqual([]);
  });

  it("skips a range whose only weekdays are declared holidays", async () => {
    const { provider, requests } = fakeProvider();
    await runHistoricalBackfill(
      { ...request, fromDate: "2026-01-05", toDate: "2026-01-06" },
      deps({
        history: provider,
        holidays: new Set(["2026-01-05", "2026-01-06"]),
      }),
    );
    expect(requests).toEqual([]);
  });

  it("processes one symbol at a time, in the order given", async () => {
    const { provider, requests } = fakeProvider();
    await runHistoricalBackfill(
      { ...request, symbols: ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"] },
      deps({ history: provider }),
    );
    expect(requests.map((r) => r.symbol)).toEqual([
      "NSE:NIFTY50-INDEX",
      "NSE:NIFTYBANK-INDEX",
    ]);
  });
});

describe("runHistoricalBackfill — the report", () => {
  it("counts stored bars and reports the trading days requested", async () => {
    const { provider } = fakeProvider(() => ({
      candles: [
        candle(ist(2026, 0, 5, 9, 15)),
        candle(ist(2026, 0, 6, 9, 15)),
        candle(ist(2026, 0, 7, 9, 15)),
        candle(ist(2026, 0, 8, 9, 15)),
        candle(ist(2026, 0, 9, 9, 15)),
      ],
      coverage: noCoverage,
      rejected: [],
      empty: false,
      pagesFetched: 2,
    }));

    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider }),
    );
    const row = report.perSymbol.get("NSE:NIFTY50-INDEX");

    expect(report.requestedTradingDays).toBe(5);
    expect(row?.stored).toBe(5);
    expect(row?.superseded).toBe(0);
    expect(row?.pagesFetched).toBe(2);
    expect(row?.daysWithNoData).toEqual([]);
    expect(backfillSucceeded(report)).toBe(true);
  });

  /**
   * D3's precedence rule at work. `false` from the storage layer means a
   * better bar is already there — a success, not an error — but it must not
   * be counted as having stored something.
   */
  it("counts a refused write as superseded, not stored", async () => {
    const { provider } = fakeProvider(() => ({
      candles: [candle(ist(2026, 0, 5, 9, 15)), candle(ist(2026, 0, 6, 9, 15))],
      coverage: noCoverage,
      rejected: [],
      empty: false,
      pagesFetched: 1,
    }));

    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider, saveCandle: () => Promise.resolve(false) }),
    );
    const row = report.perSymbol.get("NSE:NIFTY50-INDEX");

    expect(row?.stored).toBe(0);
    expect(row?.superseded).toBe(2);
  });

  it("carries the provider's rejection count through to the report", async () => {
    const { provider } = fakeProvider(() => ({
      candles: [candle(ist(2026, 0, 5, 9, 15))],
      coverage: noCoverage,
      rejected: [
        { ts: 1, reason: "high-below-low: ...", raw: [1, 2, 3, 4, 5, 6] },
        { ts: 2, reason: "ts-not-aligned: ...", raw: [2, 2, 3, 4, 5, 6] },
      ],
      empty: false,
      pagesFetched: 1,
    }));

    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider }),
    );
    expect(report.perSymbol.get("NSE:NIFTY50-INDEX")?.rejected).toBe(2);
  });

  /**
   * The distinction the trading calendar exists for: a day the exchange was
   * shut and a day the fetch came back empty both yield no bars, and only one
   * is a problem. Holidays never appear here, because they were never asked
   * for.
   */
  it("names the trading days that came back with no bars", async () => {
    const { provider } = fakeProvider(() => ({
      candles: [candle(ist(2026, 0, 5, 9, 15)), candle(ist(2026, 0, 9, 9, 15))],
      coverage: noCoverage,
      rejected: [],
      empty: false,
      pagesFetched: 1,
    }));

    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider }),
    );
    expect(report.perSymbol.get("NSE:NIFTY50-INDEX")?.daysWithNoData).toEqual([
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
    ]);
  });

  it("does not list a declared holiday as a day with no data", async () => {
    const { provider } = fakeProvider(() => ({
      candles: [candle(ist(2026, 0, 5, 9, 15))],
      coverage: noCoverage,
      rejected: [],
      empty: false,
      pagesFetched: 1,
    }));

    const report = await runHistoricalBackfill(
      { ...request, fromDate: "2026-01-05", toDate: "2026-01-06" },
      deps({ history: provider, holidays: new Set(["2026-01-06"]) }),
    );

    expect(report.perSymbol.get("NSE:NIFTY50-INDEX")?.daysWithNoData).toEqual(
      [],
    );
    expect(report.requestedTradingDays).toBe(1);
  });

  it("keeps each symbol's counts separate", async () => {
    const { provider } = fakeProvider((req) => ({
      candles:
        req.symbol === "NSE:NIFTY50-INDEX"
          ? [candle(ist(2026, 0, 5, 9, 15), req.symbol)]
          : [],
      coverage: noCoverage,
      rejected: [],
      empty: req.symbol !== "NSE:NIFTY50-INDEX",
      pagesFetched: 1,
    }));

    const report = await runHistoricalBackfill(
      { ...request, symbols: ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"] },
      deps({ history: provider }),
    );

    expect(report.perSymbol.get("NSE:NIFTY50-INDEX")?.stored).toBe(1);
    expect(report.perSymbol.get("NSE:NIFTYBANK-INDEX")?.stored).toBe(0);
    expect(
      report.perSymbol.get("NSE:NIFTYBANK-INDEX")?.daysWithNoData,
    ).toHaveLength(5);
  });

  it("reports a wall-clock span", async () => {
    const report = await runHistoricalBackfill(request, deps());
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt);
  });
});

describe("runHistoricalBackfill — failure is per range (§7.3)", () => {
  /**
   * A run that stopped at the first 500 and told nobody which days it never
   * reached leaves the operator with a dataset of unknown shape. Carrying on
   * and naming the failed ranges is what makes the result actionable.
   */
  it("records a failed range and continues with the rest", async () => {
    const { provider } = fakeProvider((req) => {
      if (req.fromTs === istMidnight("2026-01-08"))
        return new Error("HTTP 500: upstream");
      return {
        candles: [candle(req.fromTs + 33_300_000)],
        coverage: noCoverage,
        rejected: [],
        empty: false,
        pagesFetched: 1,
      };
    });

    const report = await runHistoricalBackfill(
      { ...request, fromDate: "2026-01-05", toDate: "2026-01-09" },
      deps({ history: provider, daysPerRange: 3 }),
    );
    const row = report.perSymbol.get("NSE:NIFTY50-INDEX");

    expect(row?.failures).toEqual([
      {
        fromDate: "2026-01-08",
        toDate: "2026-01-09",
        reason: "HTTP 500: upstream",
      },
    ]);
    // The first range still ran and stored its bar.
    expect(row?.stored).toBe(1);
    expect(backfillSucceeded(report)).toBe(false);
  });

  it("does not let one symbol's failure affect another", async () => {
    const { provider } = fakeProvider((req) => {
      if (req.symbol === "NSE:NIFTY50-INDEX") return new Error("boom");
      return {
        candles: [candle(ist(2026, 0, 5, 9, 15), req.symbol)],
        coverage: noCoverage,
        rejected: [],
        empty: false,
        pagesFetched: 1,
      };
    });

    const report = await runHistoricalBackfill(
      { ...request, symbols: ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"] },
      deps({ history: provider }),
    );

    expect(report.perSymbol.get("NSE:NIFTY50-INDEX")?.failures).toHaveLength(1);
    expect(report.perSymbol.get("NSE:NIFTYBANK-INDEX")?.failures).toEqual([]);
    expect(report.perSymbol.get("NSE:NIFTYBANK-INDEX")?.stored).toBe(1);
  });

  /**
   * A day with no data may simply be a holiday the configured calendar does
   * not list yet — that needs a human with a calendar, not a red build. A
   * failed range is always wrong.
   */
  it("treats days with no data as a finding, not a failure", async () => {
    const report = await runHistoricalBackfill(request, deps());
    expect(
      report.perSymbol.get("NSE:NIFTY50-INDEX")?.daysWithNoData,
    ).toHaveLength(5);
    expect(backfillSucceeded(report)).toBe(true);
  });
});

describe("runHistoricalBackfill — re-running is a no-op (D6)", () => {
  it("produces the same report when run twice over the same range", async () => {
    const script = () => ({
      candles: [candle(ist(2026, 0, 5, 9, 15)), candle(ist(2026, 0, 6, 9, 15))],
      coverage: noCoverage,
      rejected: [],
      empty: false,
      pagesFetched: 1,
    });
    const first = await runHistoricalBackfill(
      request,
      deps({ history: fakeProvider(script).provider }),
    );
    const second = await runHistoricalBackfill(
      request,
      deps({ history: fakeProvider(script).provider }),
    );

    expect(second.perSymbol.get("NSE:NIFTY50-INDEX")?.stored).toBe(
      first.perSymbol.get("NSE:NIFTY50-INDEX")?.stored,
    );
    expect(second.requestedTradingDays).toBe(first.requestedTradingDays);
  });
});

describe("progress reporting", () => {
  it("emits one event per range actually fetched", async () => {
    const events: string[] = [];
    const { provider } = fakeProvider();
    await runHistoricalBackfill(
      { ...request, fromDate: "2026-01-05", toDate: "2026-01-16" },
      deps({
        history: provider,
        daysPerRange: 7,
        onProgress: (e) => events.push(`${e.fromDate}..${e.toDate}`),
      }),
    );
    expect(events).toEqual([
      "2026-01-05..2026-01-11",
      "2026-01-12..2026-01-16",
    ]);
  });

  it("emits an event for a range that failed", async () => {
    const events: string[] = [];
    const { provider } = fakeProvider(() => new Error("nope"));
    await runHistoricalBackfill(
      request,
      deps({ history: provider, onProgress: (e) => events.push(e.fromDate) }),
    );
    expect(events).toEqual(["2026-01-05"]);
  });
});

describe("formatBackfillReport", () => {
  it("names every symbol, its counts and its failures", async () => {
    const { provider } = fakeProvider((req) =>
      req.symbol === "NSE:NIFTY50-INDEX"
        ? {
            candles: [candle(ist(2026, 0, 5, 9, 15), req.symbol)],
            rejected: [],
            coverage: noCoverage,
            empty: false,
            pagesFetched: 1,
          }
        : new Error("token expired"),
    );

    const report = await runHistoricalBackfill(
      { ...request, symbols: ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"] },
      deps({ history: provider }),
    );
    const text = formatBackfillReport(report);

    // The status label now leads the line — a reader should not have to
    // reach the end to learn the dataset is incomplete.
    expect(text).toContain("NSE:NIFTY50-INDEX [PARTIAL_HISTORY]: stored 1");
    expect(text).toContain("FAILED 2026-01-05..2026-01-09: token expired");
    expect(text).toContain("no data on 4 trading day(s)");
  });

  it("truncates a long list of empty days rather than printing hundreds", async () => {
    const report = await runHistoricalBackfill(
      { ...request, fromDate: "2026-01-05", toDate: "2026-03-31" },
      deps(),
    );
    const text = formatBackfillReport(report);
    expect(text).toMatch(/\(\+\d+ more\)/);
  });
});

describe("the three reasons a day can hold no bars (§5)", () => {
  /**
   * They look identical from the data — zero candles — and mean completely
   * different things. Collapsing any two either buries a real gap in
   * holiday noise or raises an alert every Diwali until nobody reads them.
   */
  it("classifies a fetched-but-empty trading day as DATA_MISSING", async (ctx) => {
    void ctx;
    const report = await runHistoricalBackfill(request, deps());
    const row = report.perSymbol.get(SYMBOL_A);

    expect(row?.missingPeriods).toEqual([
      {
        fromDate: "2026-01-05",
        toDate: "2026-01-09",
        cause: "DATA_MISSING",
        tradingDays: 5,
      },
    ]);
  });

  it("classifies a failed range as API_FAILURE, with the reason", async () => {
    const { provider } = fakeProvider(() => new Error("HTTP 500"));
    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider }),
    );
    const row = report.perSymbol.get(SYMBOL_A);

    expect(row?.missingPeriods[0]?.cause).toBe("API_FAILURE");
    expect(row?.missingPeriods[0]?.reason).toBe("HTTP 500");
  });

  /**
   * MARKET_CLOSED never appears as a gap: a closed day was never requested,
   * so it cannot be missing. That is the whole point of counting in trading
   * days rather than calendar days.
   */
  it("never reports a holiday or weekend as a gap", async () => {
    const report = await runHistoricalBackfill(
      { ...request, fromDate: "2026-01-03", toDate: "2026-01-06" },
      deps({ holidays: new Set(["2026-01-05"]) }),
    );
    const row = report.perSymbol.get(SYMBOL_A);

    // Sat, Sun and the holiday are all excluded; only Tuesday was asked for.
    expect(report.requestedTradingDays).toBe(1);
    for (const period of row?.missingPeriods ?? [])
      expect(period.cause).not.toBe("MARKET_CLOSED");
  });

  /**
   * A report naming 187 individual dates is one nobody reads. Runs sharing
   * a cause collapse into one period.
   */
  it("groups consecutive days of the same cause into one period", async () => {
    const { provider } = fakeProvider((req) =>
      req.fromTs === istMidnight("2026-01-08")
        ? new Error("boom")
        : {
            candles: [],
            coverage: noCoverage,
            rejected: [],
            empty: true,
            pagesFetched: 1,
          },
    );
    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider, daysPerRange: 3 }),
    );
    const row = report.perSymbol.get(SYMBOL_A);

    expect(row?.missingPeriods).toHaveLength(2);
    expect(row?.missingPeriods[0]?.cause).toBe("DATA_MISSING");
    expect(row?.missingPeriods[1]?.cause).toBe("API_FAILURE");
  });
});

describe("PARTIAL_HISTORY is never called by the range that was asked for", () => {
  const fullWeek = () => ({
    candles: [0, 1, 2, 3, 4].map((i) => candle(ist(2026, 0, 5 + i, 9, 15))),
    coverage: noCoverage,
    rejected: [],
    empty: false,
    pagesFetched: 1,
  });

  it("reports COMPLETE when every requested trading day has bars", async () => {
    const { provider } = fakeProvider(fullWeek);
    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider }),
    );
    const row = report.perSymbol.get(SYMBOL_A);

    expect(row?.status).toBe("COMPLETE");
    expect(row?.availableFrom).toBe("2026-01-05");
    expect(row?.availableTo).toBe("2026-01-09");
    expect(row?.missingPeriods).toEqual([]);
  });

  /**
   * The failure this prevents: a dataset labelled "1 year" holding eight
   * months gets used as a year by every backtest that touches it, and the
   * error surfaces as a strategy behaving oddly in a period nobody can
   * explain.
   */
  it("reports PARTIAL_HISTORY, and the range it actually got", async () => {
    const { provider } = fakeProvider(() => ({
      candles: [candle(ist(2026, 0, 5, 9, 15)), candle(ist(2026, 0, 6, 9, 15))],
      coverage: noCoverage,
      rejected: [],
      empty: false,
      pagesFetched: 1,
    }));
    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider }),
    );
    const row = report.perSymbol.get(SYMBOL_A);

    expect(row?.status).toBe("PARTIAL_HISTORY");
    expect(row?.availableFrom).toBe("2026-01-05");
    expect(row?.availableTo).toBe("2026-01-06");
    expect(row?.missingPeriods[0]).toMatchObject({
      fromDate: "2026-01-07",
      toDate: "2026-01-09",
      cause: "DATA_MISSING",
      tradingDays: 3,
    });
  });

  it("reports EMPTY when nothing at all was stored", async () => {
    const report = await runHistoricalBackfill(request, deps());
    const row = report.perSymbol.get(SYMBOL_A);

    expect(row?.status).toBe("EMPTY");
    expect(row?.availableFrom).toBeNull();
    expect(row?.availableTo).toBeNull();
  });

  /**
   * A superseded bar means a BETTER record is already stored — the opposite
   * of a gap. Counting it as missing would label a correct dataset partial.
   */
  it("counts a superseded day as covered, not missing", async () => {
    const { provider } = fakeProvider(fullWeek);
    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider, saveCandle: () => Promise.resolve(false) }),
    );
    const row = report.perSymbol.get(SYMBOL_A);

    expect(row?.status).toBe("COMPLETE");
    expect(row?.stored).toBe(0);
    expect(row?.superseded).toBe(5);
  });

  it("names PARTIAL_HISTORY in the printed report", async () => {
    const { provider } = fakeProvider(() => ({
      candles: [candle(ist(2026, 0, 5, 9, 15))],
      coverage: noCoverage,
      rejected: [],
      empty: false,
      pagesFetched: 1,
    }));
    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider }),
    );
    const text = formatBackfillReport(report);

    expect(text).toContain("PARTIAL_HISTORY");
    expect(text).toContain("available: 2026-01-05 .. 2026-01-05");
    expect(text).toContain("DATA_MISSING 2026-01-06..2026-01-09");
  });
});

describe("a truncated response is surfaced, not absorbed", () => {
  /**
   * §3.1 Q1: FYERS may cap a too-long range, return a prefix, and still
   * answer ok. The provider detects the shape; the job must carry it into
   * the report, because the operator is the one who can lower the page
   * size.
   */
  it("counts responses that stopped early", async () => {
    const { provider } = fakeProvider(() => ({
      candles: [candle(ist(2026, 0, 5, 9, 15))],
      coverage: { ...noCoverage, truncated: true },
      rejected: [],
      empty: false,
      pagesFetched: 1,
    }));
    const report = await runHistoricalBackfill(
      request,
      deps({ history: provider }),
    );

    expect(report.perSymbol.get(SYMBOL_A)?.truncatedResponses).toBe(1);
    expect(formatBackfillReport(report)).toContain("stopped early");
  });

  it("counts zero when every response was complete", async () => {
    const report = await runHistoricalBackfill(request, deps());
    expect(report.perSymbol.get(SYMBOL_A)?.truncatedResponses).toBe(0);
  });
});
