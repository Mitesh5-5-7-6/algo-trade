import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import type { HistoryRequest, HistoryResult } from "@neelkanth/broker";
import { catchUpSession, closedWindow } from "./session-catch-up.js";

/** 2026-11-18 09:15 IST. */
const OPEN = Date.UTC(2026, 10, 18, 3, 45);
const MIN = 60_000;

const bar = (symbol: string, ts: number): Candle => ({
  symbol,
  interval: "5m",
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10,
  ts,
  source: "BROKER_HISTORICAL",
});

function fakeHistory(answer: (req: HistoryRequest) => Candle[] | Error): {
  getHistory: (req: HistoryRequest) => Promise<HistoryResult>;
  asked: HistoryRequest[];
} {
  const asked: HistoryRequest[] = [];
  return {
    asked,
    getHistory: (req) => {
      asked.push(req);
      const out = answer(req);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve({
        candles: out,
        coverage: {
          requestedFrom: req.fromTs,
          requestedTo: req.toTs,
          requestedDays: [],
          coveredDays: [],
          missingDays: [],
          truncated: false,
        },
        rejected: [],
        empty: out.length === 0,
        pagesFetched: 1,
      });
    },
  };
}

describe("the session catch-up (15.3)", () => {
  it("asks only for buckets that have closed since the open", () => {
    // 09:29:31 — the token's arrival on 2026-11-18.
    const now = OPEN + 14 * MIN + 31_000;
    expect(closedWindow(now, OPEN, "5m")).toEqual({
      fromTs: OPEN,
      toTs: OPEN + 10 * MIN, // 09:15 and 09:20 closed; 09:25 is still forming
    });
    expect(closedWindow(now, OPEN, "1m")).toEqual({
      fromTs: OPEN,
      toTs: OPEN + 14 * MIN,
    });
    // Before the first bucket closes there is nothing to ask for.
    expect(closedWindow(OPEN + 3 * MIN, OPEN, "5m")).toBeNull();
    expect(closedWindow(OPEN - MIN, OPEN, "1m")).toBeNull();
  });

  it("stores what the broker returns and counts what a better bar outranked", async () => {
    const history = fakeHistory((req) => [
      bar(req.symbol, OPEN),
      bar(req.symbol, OPEN + 5 * MIN),
    ]);
    const saved: Candle[] = [];
    const items = await catchUpSession(
      {
        now: OPEN + 16 * MIN,
        sessionOpenTs: OPEN,
        symbols: ["NSE:NIFTYBANK-INDEX"],
        intervals: ["5m"],
      },
      {
        history,
        save: (c) => {
          saved.push(c);
          // The 09:20 bucket already holds a broker bar.
          return Promise.resolve(c.ts !== OPEN + 5 * MIN);
        },
      },
    );
    expect(history.asked).toEqual([
      {
        symbol: "NSE:NIFTYBANK-INDEX",
        interval: "5m",
        fromTs: OPEN,
        toTs: OPEN + 15 * MIN,
      },
    ]);
    expect(saved.map((c) => c.ts)).toEqual([OPEN, OPEN + 5 * MIN]);
    expect(items).toEqual([
      { symbol: "NSE:NIFTYBANK-INDEX", interval: "5m", fetched: 2, stored: 1 },
    ]);
  });

  it("records a failed symbol and carries on with the rest", async () => {
    const history = fakeHistory((req) =>
      req.symbol === "NSE:THIN26NOVCE"
        ? new Error("history request rejected (HTTP 400)")
        : [bar(req.symbol, OPEN)],
    );
    const items = await catchUpSession(
      {
        now: OPEN + 6 * MIN,
        sessionOpenTs: OPEN,
        symbols: ["NSE:THIN26NOVCE", "NSE:NIFTY50-INDEX"],
        intervals: ["5m"],
      },
      { history, save: () => Promise.resolve(true) },
    );
    expect(items).toEqual([
      {
        symbol: "NSE:THIN26NOVCE",
        interval: "5m",
        fetched: 0,
        stored: 0,
        error: "history request rejected (HTTP 400)",
      },
      { symbol: "NSE:NIFTY50-INDEX", interval: "5m", fetched: 1, stored: 1 },
    ]);
  });

  it("asks nothing before a bucket has closed", async () => {
    const history = fakeHistory(() => []);
    const items = await catchUpSession(
      {
        now: OPEN + 30_000,
        sessionOpenTs: OPEN,
        symbols: ["NSE:NIFTY50-INDEX"],
        intervals: ["1m", "5m"],
      },
      { history, save: () => Promise.resolve(true) },
    );
    expect(items).toEqual([]);
    expect(history.asked).toEqual([]);
  });
});
