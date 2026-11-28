import { describe, expect, it } from "vitest";
import type { DayContext } from "./day-context.js";
import {
  heavyweightBreadth,
  heavyweightsOf,
  ALL_HEAVYWEIGHTS,
} from "./heavyweights.js";
import {
  applyLessons,
  describeLesson,
  judgeLesson,
  signalFeatures,
  type AppliedLesson,
  type SignalFeatures,
} from "./lesson.js";

const banks = heavyweightsOf("BANKNIFTY");
const quotes = (changes: number[]) =>
  new Map(
    banks.map((s, i) => [
      s,
      { prevClose: 100, last: 100 * (1 + (changes[i] ?? 0) / 100) },
    ]),
  );

const day = (over: Partial<DayContext> = {}): DayContext => ({
  date: "2026-11-30",
  builtAt: 1,
  events: [],
  overnight: null,
  flags: [],
  stockTone: [],
  headlinesRead: 0,
  ai: null,
  notes: [],
  ...over,
});

const base = {
  underlying: "BANKNIFTY",
  minuteOfDay: 10 * 60 + 5,
  price: 51_000,
  todayOpen: 50_500,
  prevClose: 50_000,
  expiryDay: false,
};

describe("heavyweights (14.25)", () => {
  it("lists BANK NIFTY's big five banks inside NIFTY's eleven, each once overall", () => {
    expect(banks).toHaveLength(5);
    for (const b of banks) expect(heavyweightsOf("NIFTY")).toContain(b);
    expect(new Set(ALL_HEAVYWEIGHTS).size).toBe(ALL_HEAVYWEIGHTS.length);
    expect(heavyweightsOf("FINNIFTY")).toEqual([]);
  });

  it("counts up, down and flat against yesterday's close", () => {
    const b = heavyweightBreadth("BANKNIFTY", quotes([1, 0.5, -0.4, 0.01, 2]));
    expect(b).toMatchObject({ total: 5, up: 3, down: 1, flat: 1 });
    expect(b?.avgChangePct).toBeCloseTo(0.622, 3);
  });

  it("claims nothing from fewer than half the basket", () => {
    const two = new Map([...quotes([1, 1])].slice(0, 2));
    expect(heavyweightBreadth("BANKNIFTY", two)).toBeNull();
  });
});

describe("signal features (14.26)", () => {
  it("signs every move with the trade, so a put reads the same as a call", () => {
    const breadth = heavyweightBreadth("BANKNIFTY", quotes([1, 1, 1, -1, 0]));
    const call = signalFeatures({ ...base, direction: 1, breadth, day: null });
    const put = signalFeatures({ ...base, direction: -1, breadth, day: null });
    expect(call.indexDayWithPct).toBeCloseTo(2, 6);
    expect(put.indexDayWithPct).toBeCloseTo(-2, 6);
    expect(call.heavyweights).toMatchObject({ withCount: 3, againstCount: 1 });
    expect(put.heavyweights).toMatchObject({ withCount: 1, againstCount: 3 });
  });

  it("reads events, the US overnight and the news tone off the day context", () => {
    const f = signalFeatures({
      ...base,
      direction: -1,
      breadth: null,
      day: day({
        events: [
          {
            date: "2026-11-30",
            kind: "RBI_POLICY",
            title: "MPC",
            symbols: [],
            source: "rbi",
          },
        ],
        overnight: {
          date: "2026-11-30",
          usDate: "2026-11-27",
          spxChangePct: -1.5,
          ndxChangePct: -2,
          source: "y",
        },
        stockTone: [
          { symbol: "NSE:HDFCBANK-EQ", tone: -1, headlineIds: ["a"] },
          { symbol: "NSE:SBIN-EQ", tone: -1, headlineIds: ["b"] },
          { symbol: "NSE:INFY-EQ", tone: 1, headlineIds: ["c"] }, // not a bank: ignored
        ],
        ai: { provider: "gemini", model: "m", at: 1 },
      }),
    });
    expect(f.events).toEqual(["RBI_POLICY"]);
    expect(f.overnightWithPct).toBeCloseTo(1.5, 6); // the US fell: with a put
    expect(f.newsWith).toBeCloseTo(0.4, 6); // two bad banks of five, with a put
  });

  it("takes RBI, Budget and Fed days from the calendar only, never from a headline", () => {
    const f = signalFeatures({
      ...base,
      direction: 1,
      breadth: null,
      day: day({
        flags: [
          {
            kind: "RBI_POLICY",
            detail: "an RBI circular",
            symbols: [],
            tone: 0,
            headlineIds: ["a"],
          },
          {
            kind: "RESULTS",
            detail: "HDFC Bank results today",
            symbols: ["NSE:HDFCBANK-EQ"],
            tone: 0,
            headlineIds: ["b"],
          },
        ],
        ai: { provider: "gemini", model: "m", at: 1 },
      }),
    });
    expect(f.events).toEqual(["RESULTS"]);
  });

  it("says unknown, not neutral, when no morning read ran", () => {
    const f = signalFeatures({
      ...base,
      direction: 1,
      breadth: null,
      day: day(),
    });
    expect(f.newsWith).toBeNull();
    expect(f.overnightWithPct).toBeNull();
  });
});

const features = (over: Partial<SignalFeatures> = {}): SignalFeatures => ({
  underlying: "BANKNIFTY",
  direction: 1,
  minuteOfDay: 600,
  indexFromOpenWithPct: 0.3,
  indexDayWithPct: 0.5,
  heavyweights: { total: 5, withCount: 4, againstCount: 1, avgWithPct: 0.6 },
  events: [],
  overnightWithPct: 0.4,
  newsWith: 0,
  expiryDay: false,
  ...over,
});

describe("lessons judge a signal (14.27)", () => {
  it("passes, blocks, or says unknown when its input is missing", () => {
    const c = { kind: "HEAVYWEIGHTS_WITH", minShare: 0.6 } as const;
    expect(judgeLesson(c, features())).toBe("pass");
    expect(
      judgeLesson(
        c,
        features({
          heavyweights: {
            total: 5,
            withCount: 2,
            againstCount: 3,
            avgWithPct: -0.2,
          },
        }),
      ),
    ).toBe("block");
    expect(judgeLesson(c, features({ heavyweights: null }))).toBe("unknown");
  });

  it("skips event days and US moves against the trade", () => {
    expect(
      judgeLesson(
        { kind: "SKIP_EVENT_DAY", events: ["RBI_POLICY"] },
        features({ events: ["RBI_POLICY"] }),
      ),
    ).toBe("block");
    expect(
      judgeLesson(
        { kind: "SKIP_EVENT_DAY", events: ["RBI_POLICY"] },
        features({ events: ["FOMC"] }),
      ),
    ).toBe("pass");
    expect(
      judgeLesson(
        { kind: "OVERNIGHT_NOT_AGAINST", maxAgainstPct: 1 },
        features({ overnightWithPct: -1 }),
      ),
    ).toBe("block");
    expect(
      judgeLesson(
        { kind: "OVERNIGHT_NOT_AGAINST", maxAgainstPct: 1 },
        features({ overnightWithPct: -0.9 }),
      ),
    ).toBe("pass");
  });

  it("describes every lesson in plain words", () => {
    expect(
      describeLesson({ kind: "TIME_WINDOW", fromMinute: 615, toMinute: 810 }),
    ).toBe("Take trades only between 10:15 and 13:30");
  });
});

describe("applied lessons (14.28)", () => {
  const lesson = (over: Partial<AppliedLesson> = {}): AppliedLesson => ({
    lessonId: "l1",
    scope: {
      rule: "MOMENTUM",
      underlying: "BANKNIFTY",
      strategyTypes: ["INDEX_OPTION_MOMENTUM"],
    },
    condition: { kind: "HEAVYWEIGHTS_WITH", minShare: 0.6 },
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
    ...over,
  });
  const against = features({
    heavyweights: { total: 5, withCount: 1, againstCount: 4, avgWithPct: -1 },
  });

  it("blocks a signal an active lesson in scope blocks", () => {
    expect(
      applyLessons([lesson()], "INDEX_OPTION_MOMENTUM", against).blocked
        ?.lessonId,
    ).toBe("l1");
  });

  it("ignores lessons out of scope or stopped", () => {
    expect(applyLessons([lesson()], "ORB", against).blocked).toBeNull();
    expect(
      applyLessons(
        [lesson({ status: "STOPPED" })],
        "INDEX_OPTION_MOMENTUM",
        against,
      ).blocked,
    ).toBeNull();
    expect(
      applyLessons([lesson()], "INDEX_OPTION_MOMENTUM", {
        ...against,
        underlying: "NIFTY",
      }).blocked,
    ).toBeNull();
  });

  it("does not block when it cannot judge, and keeps the judgement", () => {
    const r = applyLessons(
      [lesson()],
      "INDEX_OPTION_MOMENTUM",
      features({ heavyweights: null }),
    );
    expect(r.blocked).toBeNull();
    expect(r.judgements).toEqual([{ lessonId: "l1", judgement: "unknown" }]);
  });
});
