import { describe, expect, it } from "vitest";
import type {
  AppliedLesson,
  Candle,
  SignalContext,
  Signal,
} from "@neelkanth/core";
import { LessonDesk } from "./lesson-desk.js";

/** 2026-11-30 10:05 IST. */
const NOW = Date.UTC(2026, 10, 30, 4, 35);
const YESTERDAY_CLOSE_TS = Date.UTC(2026, 10, 27, 9, 55);
const TODAY_OPEN_TS = Date.UTC(2026, 10, 30, 3, 45);

const bar = (
  symbol: string,
  ts: number,
  open: number,
  close: number,
): Candle => ({
  symbol,
  interval: "5m",
  source: "LIVE_TICK",
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume: 0,
  ts,
});

const BANKS = [
  "NSE:HDFCBANK-EQ",
  "NSE:ICICIBANK-EQ",
  "NSE:SBIN-EQ",
  "NSE:KOTAKBANK-EQ",
  "NSE:AXISBANK-EQ",
];

function desk(
  over: {
    lessons?: AppliedLesson[];
    prices?: Record<string, number>;
    failPersist?: boolean;
  } = {},
) {
  const kept: SignalContext[] = [];
  const errors: unknown[] = [];
  const prices: Record<string, number> = {
    "NSE:NIFTYBANK-INDEX": 51_000,
    // Four of five banks down on the day: against a call.
    "NSE:HDFCBANK-EQ": 99,
    "NSE:ICICIBANK-EQ": 99,
    "NSE:SBIN-EQ": 99,
    "NSE:KOTAKBANK-EQ": 99,
    "NSE:AXISBANK-EQ": 101,
    ...over.prices,
  };
  const d = new LessonDesk({
    findBars: (symbol, from) =>
      Promise.resolve(
        from < TODAY_OPEN_TS - 2 * 86_400_000 // the seven-day look back for yesterday
          ? [
              bar(
                symbol,
                YESTERDAY_CLOSE_TS,
                100,
                symbol.endsWith("-INDEX") ? 50_000 : 100,
              ),
            ]
          : symbol.endsWith("-INDEX")
            ? [bar(symbol, TODAY_OPEN_TS, 50_500, 50_600)]
            : [],
      ),
    readPrice: (s) => prices[s] ?? null,
    nearestExpiry: () => Date.UTC(2026, 11, 29, 10),
    readActiveLessons: () => Promise.resolve(over.lessons ?? []),
    persistContext: (c) => {
      if (over.failPersist === true)
        return Promise.reject(new Error("mongo down"));
      kept.push(c);
      return Promise.resolve();
    },
    onError: (e) => errors.push(e),
  });
  return { d, kept, errors };
}

const signal = (over: Partial<Signal> = {}): Signal => ({
  signalId: "sig_1",
  strategyId: "str_bn",
  symbol: "NSE:BANKNIFTY26DEC51000CE",
  underlyingSymbol: "NSE:NIFTYBANK-INDEX",
  side: "BUY",
  confidence: 0.8,
  reason: "breakout",
  contextSnapshot: {
    price: 51_000,
    indicators: {},
    session: "open",
    sentiment: 0,
  },
  ts: NOW,
  ...over,
});

const lesson: AppliedLesson = {
  lessonId: "MOMENTUM.BANKNIFTY.HEAVYWEIGHTS_NOT_AGAINST.maxAgainstShare=0.6",
  scope: {
    rule: "MOMENTUM",
    underlying: "BANKNIFTY",
    strategyTypes: ["INDEX_OPTION_MOMENTUM"],
  },
  condition: { kind: "HEAVYWEIGHTS_NOT_AGAINST", maxAgainstShare: 0.6 },
  summary: "s",
  status: "ACTIVE",
  appliedAt: 1,
  appliedBy: "operator",
  promised: {
    test: {
      from: "a",
      to: "b",
      all: {
        n: 0,
        wins: 0,
        winRate: null,
        profitFactor: null,
        avgNetPct: null,
      },
      kept: {
        n: 0,
        wins: 0,
        winRate: null,
        profitFactor: null,
        avgNetPct: null,
      },
      blocked: {
        n: 0,
        wins: 0,
        winRate: null,
        profitFactor: null,
        avgNetPct: null,
      },
      unknown: 0,
    },
    pValue: 0.01,
  },
};

describe("the lesson desk (14.26, 14.28)", () => {
  it("reads a call's conditions from yesterday's closes, today's open and the banks", async () => {
    const { d } = desk();
    await d.refreshDay(NOW);
    const f = d.featuresFor(signal(), NOW);
    expect(f).toMatchObject({
      underlying: "BANKNIFTY",
      direction: 1,
      expiryDay: false,
    });
    expect(f?.indexDayWithPct).toBeCloseTo(2, 6);
    expect(f?.indexFromOpenWithPct).toBeCloseTo((500 / 50_500) * 100, 6);
    expect(f?.heavyweights).toMatchObject({
      total: 5,
      withCount: 1,
      againstCount: 4,
    });
    expect(BANKS).toHaveLength(5);
  });

  it("blocks through an applied lesson, keeps the conditions, and hands the verdict to risk once", async () => {
    const { d, kept } = desk({ lessons: [lesson] });
    await d.refreshLessons();
    await d.refreshDay(NOW);
    d.judge(signal(), "INDEX_OPTION_MOMENTUM", NOW);
    expect(d.verdictFor(signal())).toMatchObject({ blocked: true });
    expect(d.verdictFor(signal())).toBeNull();
    await Promise.resolve();
    expect(kept[0]?.lessons).toEqual([
      { lessonId: lesson.lessonId, judgement: "block" },
    ]);
  });

  it("has no verdict when no lesson is in scope, and still keeps the conditions", async () => {
    const { d, kept } = desk({ lessons: [lesson] });
    await d.refreshLessons();
    await d.refreshDay(NOW);
    d.judge(signal(), "ORB", NOW);
    expect(d.verdictFor(signal())).toBeNull();
    await Promise.resolve();
    expect(kept).toHaveLength(1);
  });

  it("never throws into the order path when keeping fails", async () => {
    const { d, errors } = desk({ lessons: [lesson], failPersist: true });
    await d.refreshLessons();
    await d.refreshDay(NOW);
    expect(() => {
      d.judge(signal(), "INDEX_OPTION_MOMENTUM", NOW);
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
  });
});
