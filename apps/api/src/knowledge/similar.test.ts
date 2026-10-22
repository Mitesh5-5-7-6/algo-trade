import { describe, expect, it } from "vitest";
import type {
  DayFeatures,
  PatternObservation,
} from "../research/observations.js";
import { similarSessions, type SessionInput } from "./similar.js";

/** Task 10.5 (design D4, D5): the sessions most like a day — standardised, deterministic, never from the future. */
const features = (over: Partial<DayFeatures> = {}): DayFeatures => ({
  symbol: "NSE:X-INDEX",
  bars: 75,
  open: 100,
  high: 102,
  low: 98,
  close: 101,
  range: 4,
  returnPct: 0.01,
  gapPct: 0,
  realisedVolatility: 0.001,
  specialSession: false,
  regimeAtClose: "BULLISH",
  sources: {},
  ingestionVersions: [],
  volumeQuality: {},
  ...over,
});
const pattern = (patternId: string): PatternObservation => ({
  patternId,
  detectorVersion: "1.0.0",
  ts: 0,
  direction: "BULLISH",
  evidence: {},
  marketContext: {},
  regime: "BULLISH",
  strategies: {},
});
const session = (
  date: string,
  over: Partial<DayFeatures> = {},
  patterns: string[] = [],
  symbol = "NSE:X-INDEX",
): SessionInput => ({
  date,
  symbol,
  features: features(over),
  patterns: patterns.map(pattern),
});

const POOL = [
  session("2026-03-02", { returnPct: 0.012, gapPct: -0.02 }, ["ORB_BREAKOUT"]),
  session(
    "2026-03-04",
    { returnPct: -0.015, gapPct: 0.01, regimeAtClose: "BEARISH" },
    ["RSI_REVERSION", "RSI_REVERSION"],
  ),
  session("2026-03-05", { returnPct: 0.002, gapPct: 0.001 }),
  session("2026-03-06", { returnPct: 0.011, gapPct: -0.019 }, ["ORB_BREAKOUT"]),
];

describe("similar sessions (10.5, D4)", () => {
  it("finds the session most like the target", () => {
    const target = session(
      "2026-03-09",
      { returnPct: 0.0112, gapPct: -0.0192 },
      ["ORB_BREAKOUT"],
    );
    const a = similarSessions(target, POOL, { k: 2 });
    expect(a.nearest.map((s) => s.date)).toEqual(["2026-03-06", "2026-03-02"]);
    expect(a.poolSize).toBe(4);
    expect(a.modelVersion).toBe("1");
  });

  /** An identical day is at distance zero. */
  it("puts an identical session at distance zero", () => {
    const twin = session("2026-03-09", { returnPct: 0.002, gapPct: 0.001 });
    expect(similarSessions(twin, POOL).nearest[0]).toMatchObject({
      date: "2026-03-05",
      distance: 0,
    });
  });

  /** Standardised: changing a dimension's units changes no ranking. */
  it("does not let one dimension's scale dominate", () => {
    const target = session(
      "2026-03-09",
      { returnPct: 0.0115, gapPct: -0.0195 },
      ["ORB_BREAKOUT"],
    );
    const scaled = (s: SessionInput): SessionInput => ({
      ...s,
      features: { ...s.features, returnPct: s.features.returnPct * 1000 },
    });
    expect(
      similarSessions(scaled(target), POOL.map(scaled)).nearest.map(
        (s) => s.date,
      ),
    ).toEqual(similarSessions(target, POOL).nearest.map((s) => s.date));
  });

  /**
   * A small move in a dimension that rarely moves outweighs a larger one in a
   * dimension that always does — raw distance would pick the other way.
   */
  it("measures distance in units of each dimension's spread", () => {
    const target = session("2026-03-09", {
      returnPct: 0,
      realisedVolatility: 0.001,
    });
    const offReturn = session("2026-03-03", {
      returnPct: 0.01,
      realisedVolatility: 0.001,
    });
    const offVol = session("2026-03-02", {
      returnPct: 0,
      realisedVolatility: 0.0015,
    });
    const spread = [
      session("2026-03-04", { returnPct: 0.05, realisedVolatility: 0.001 }),
      session("2026-03-05", { returnPct: -0.05, realisedVolatility: 0.001 }),
    ];
    expect(
      similarSessions(target, [offVol, offReturn, ...spread]).nearest[0]?.date,
    ).toBe("2026-03-03");
  });

  it("weighs which patterns occurred", () => {
    const target = session("2026-03-09", {}, ["ORB_BREAKOUT"]);
    const without = session("2026-03-02", {});
    const withOrb = session("2026-03-03", {}, ["ORB_BREAKOUT"]);
    expect(
      similarSessions(target, [without, withOrb]).nearest[0],
    ).toMatchObject({ date: "2026-03-03", distance: 0 });
  });

  it("weighs regime: the same numbers in another regime are further", () => {
    const bear = session("2026-03-02", {
      returnPct: 0.01,
      regimeAtClose: "BEARISH",
    });
    const bull = session("2026-03-03", { returnPct: 0.01 });
    const target = session("2026-03-09", { returnPct: 0.01 });
    expect(
      similarSessions(target, [
        bear,
        bull,
        session("2026-03-04", { returnPct: 0.03 }),
      ]).nearest[0]?.date,
    ).toBe("2026-03-03");
  });

  it("is deterministic, ties broken by date then symbol", () => {
    const a = session("2026-03-02", {}, [], "NSE:B-INDEX");
    const b = session("2026-03-02", {}, [], "NSE:A-INDEX");
    const c = session("2026-03-01", {});
    const out = similarSessions(session("2026-03-09"), [a, b, c]).nearest.map(
      (s) => `${s.date} ${s.symbol}`,
    );
    expect(out).toEqual([
      "2026-03-01 NSE:X-INDEX",
      "2026-03-02 NSE:A-INDEX",
      "2026-03-02 NSE:B-INDEX",
    ]);
  });
});

describe("nothing from the future (10.5, D5)", () => {
  const target = session("2026-03-05", { returnPct: 0.002, gapPct: 0.001 });
  const later = [
    session("2026-03-06", { returnPct: 0.002, gapPct: 0.001 }),
    session("2026-03-20", {
      returnPct: 0.5,
      gapPct: 0.4,
      realisedVolatility: 0.9,
    }),
  ];

  it("never returns a session after asOf — by default, the target's own date", () => {
    const a = similarSessions(target, [...POOL, ...later]);
    expect(a.nearest.every((s) => s.date <= "2026-03-05")).toBe(true);
    expect(
      a.nearest.some(
        (s) => s.date === "2026-03-05" && s.symbol === target.symbol,
      ),
    ).toBe(false); // not itself
  });

  /** Even the scale is the past's: an extreme later day changes nothing. */
  it("standardises over the past only", () => {
    const without = similarSessions(
      target,
      POOL.filter((s) => s.date <= "2026-03-04"),
    );
    const withLater = similarSessions(target, [
      ...POOL.filter((s) => s.date <= "2026-03-04"),
      ...later,
    ]);
    expect(withLater).toEqual(without);
  });

  it("refuses a target after asOf, and reports the pool's date range", () => {
    expect(() => similarSessions(target, POOL, { asOf: "2026-03-04" })).toThrow(
      /after asOf/,
    );
    expect(similarSessions(target, [...POOL, ...later]).range).toEqual({
      fromDate: "2026-03-02",
      toDate: "2026-03-04",
    });
    expect(similarSessions(target, later).range).toBeNull();
  });

  it("can be restricted to the target's own instrument", () => {
    const other = session(
      "2026-03-04",
      { returnPct: 0.002, gapPct: 0.001 },
      [],
      "NSE:Y-INDEX",
    );
    expect(
      similarSessions(target, [...POOL, other], {
        sameSymbol: true,
      }).nearest.every((s) => s.symbol === "NSE:X-INDEX"),
    ).toBe(true);
  });
});
