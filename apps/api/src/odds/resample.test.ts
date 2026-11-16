import { describe, expect, it } from "vitest";
import { istDayStart, type Candle } from "@neelkanth/core";
import type { SessionPool } from "./pool.js";
import { resample, type OddsPlan } from "./resample.js";

const BARS = 75;

/** One bar's shape, as ratios to the bar before it. */
interface Shape {
  open: number;
  high: number;
  low: number;
  close: number;
}
const FLAT: Shape = { open: 1, high: 1, low: 1, close: 1 };
/** Rises 1 % without dipping. */
const UP: Shape = { open: 1, high: 1.01, low: 1, close: 1.01 };
/** Falls 1 % without rising. */
const DOWN: Shape = { open: 1, high: 1, low: 0.99, close: 0.99 };
/** Swings 5 % both ways inside one bar and closes where it began. */
const WILD: Shape = { open: 1, high: 1.05, low: 0.95, close: 1 };
/** Opens 5 % lower than the last close and stays there. */
const GAP_DOWN: Shape = { open: 0.95, high: 0.95, low: 0.95, close: 0.95 };

/**
 * A pool of `sessions` identical days, bar `i` shaped by `shapeAt(i)`.
 * Prices start at 100 and follow the shapes, so a bar's ratios to the one
 * before it are exactly its shape.
 */
function pool(shapeAt: (bar: number) => Shape, sessions = 3): SessionPool {
  return {
    barsPerSession: BARS,
    excluded: [],
    sessions: Array.from({ length: sessions }, (_, day) => {
      const date = `2026-03-0${String(day + 2)}`;
      let previous = 100;
      const bars: Candle[] = [];
      for (let i = 0; i < BARS; i += 1) {
        const s = shapeAt(i);
        bars.push({
          symbol: "NSE:NIFTY50-INDEX",
          interval: "5m",
          ts: istDayStart(date) + (555 + 5 * i) * 60_000,
          open: previous * s.open,
          high: previous * s.high,
          low: previous * s.low,
          close: previous * s.close,
          volume: 0,
          source: "BROKER_HISTORICAL",
        });
        previous *= s.close;
      }
      return { date, bars };
    }),
  };
}

/** Long from 100: stop 1 below, target 2 above — a 2R plan. */
const LONG: OddsPlan = {
  side: "LONG",
  entry: 100,
  stop: 99,
  target: 102,
  entryBar: 10,
};
const SHORT: OddsPlan = {
  side: "SHORT",
  entry: 100,
  stop: 101,
  target: 98,
  entryBar: 10,
};
const RUN = { replays: 200, seed: 19, window: 0 };

describe("the setup-odds resampling engine (17.3)", () => {
  it("reaches the target every time when every bar rises, and pays the plan's R", () => {
    const result = resample(
      LONG,
      pool(() => UP),
      RUN,
    );
    expect(result).toMatchObject({
      replays: 200,
      targetFirst: 200,
      stopFirst: 0,
      neither: 0,
      targetR: 2,
      averageR: 2,
    });
  });

  it("hits the stop every time when every bar falls, at minus one R", () => {
    const result = resample(
      LONG,
      pool(() => DOWN),
      RUN,
    );
    expect(result).toMatchObject({
      targetFirst: 0,
      stopFirst: 200,
      averageR: -1,
    });
  });

  it("reads a short the other way round", () => {
    expect(
      resample(
        SHORT,
        pool(() => DOWN),
        RUN,
      ),
    ).toMatchObject({
      targetFirst: 200,
      stopFirst: 0,
      averageR: 2,
    });
    expect(
      resample(
        SHORT,
        pool(() => UP),
        RUN,
      ),
    ).toMatchObject({
      targetFirst: 0,
      stopFirst: 200,
      averageR: -1,
    });
  });

  it("counts a bar that touches both the stop and the target as the stop", () => {
    for (const plan of [LONG, SHORT]) {
      const result = resample(
        plan,
        pool(() => WILD),
        RUN,
      );
      expect(result).toMatchObject({ targetFirst: 0, stopFirst: 200 });
    }
  });

  it("decides nothing on a flat market, and the R of an undecided replay is where it closed", () => {
    expect(
      resample(
        LONG,
        pool(() => FLAT),
        RUN,
      ),
    ).toMatchObject({
      targetFirst: 0,
      stopFirst: 0,
      neither: 200,
      averageR: 0,
    });

    // One bar left, rising 1 %: half way to a 2-point target, so +1R of a
    // 1-point risk — undecided, and scored at its close rather than as zero.
    const lastBar = { ...LONG, entryBar: BARS - 2 };
    expect(
      resample(
        lastBar,
        pool(() => UP),
        RUN,
      ),
    ).toMatchObject({
      neither: 200,
      averageR: 1,
    });
  });

  it("counts a gap through the stop as the stop, at minus one R, and says how many", () => {
    const result = resample(
      LONG,
      pool(() => GAP_DOWN),
      RUN,
    );
    expect(result).toMatchObject({
      stopFirst: 200,
      gapThroughStop: 200,
      averageR: -1,
    });
    // An ordinary fall reaches the stop inside the bar: no gap to report.
    expect(
      resample(
        LONG,
        pool(() => DOWN),
        RUN,
      ).gapThroughStop,
    ).toBe(0);
  });

  it("replays only the bars after the entry, each from its own time of day", () => {
    // The morning collapses; from bar 40 on the day only rises. A plan
    // entered at bar 40 must never be handed a morning bar.
    const split = pool((bar) => (bar <= 40 ? DOWN : UP));
    const afternoon = { ...LONG, entryBar: 40 };
    expect(resample(afternoon, split, RUN)).toMatchObject({
      targetFirst: 200,
      stopFirst: 0,
    });
    // Entered on the final bar, nothing is left to replay.
    const atClose = { ...LONG, entryBar: BARS - 1 };
    expect(resample(atClose, split, RUN)).toMatchObject({
      neither: 200,
      averageR: 0,
    });
  });

  it("draws from neighbouring times of day only as far as the window allows", () => {
    // Bar 41 alone collapses. Entered at bar 41, a plan's first replayed bar
    // is 42: with no window the collapse is out of reach, with a window of
    // one it is drawn about a third of the time.
    const oneBadBar = pool((bar) => (bar === 41 ? DOWN : FLAT));
    const plan = { ...LONG, entryBar: 41 };
    expect(resample(plan, oneBadBar, { ...RUN, window: 0 }).stopFirst).toBe(0);
    const widened = resample(plan, oneBadBar, { ...RUN, window: 1 }).stopFirst;
    expect(widened).toBeGreaterThan(30);
    expect(widened).toBeLessThan(110);
  });

  it("gives the same result for the same seed, and another for another", () => {
    // Half the days rise from the entry and half fall, so each replay is a
    // coin toss that the seed alone decides.
    const mixed: SessionPool = {
      ...pool(() => UP, 2),
      sessions: [
        ...pool(() => UP, 1).sessions,
        ...pool(() => DOWN, 1).sessions,
      ],
    };
    const a = resample(LONG, mixed, RUN);
    expect(resample(LONG, mixed, RUN)).toEqual(a);
    expect(a.targetFirst).toBeGreaterThan(0);
    expect(a.stopFirst).toBeGreaterThan(0);
    const seeds = [1, 2, 3, 4, 5].map(
      (seed) => resample(LONG, mixed, { ...RUN, seed }).targetFirst,
    );
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("reports where the replayed day closes, carrying on past the plan's own exit", () => {
    // Every bar rises 1 %: the target is reached on the second bar, and the
    // day still runs the rest of its 64 bars to the close.
    const bands = resample(
      LONG,
      pool(() => UP),
      RUN,
    ).closeBands;
    const close = 100 * 1.01 ** 64;
    expect(bands.p5).toBeCloseTo(close, 6);
    expect(bands.p50).toBeCloseTo(close, 6);
    expect(bands.p95).toBeCloseTo(close, 6);
  });

  it("spreads the bands across the closes the pool can produce", () => {
    // One bar left: it rises 1 % in one session and falls 1 % in the other,
    // so a replayed day closes at 101 or at 99 and nowhere else.
    const lastBar = BARS - 1;
    const split: SessionPool = {
      ...pool(() => FLAT, 1),
      sessions: [
        ...pool((bar) => (bar === lastBar ? UP : FLAT), 1).sessions,
        ...pool((bar) => (bar === lastBar ? DOWN : FLAT), 1).sessions,
      ],
    };
    const bands = resample(
      { ...LONG, entryBar: BARS - 2 },
      split,
      RUN,
    ).closeBands;
    expect(bands.p5).toBeCloseTo(99, 9);
    expect(bands.p95).toBeCloseTo(101, 9);
    expect(bands.p25).toBeLessThanOrEqual(bands.p50);
    expect(bands.p50).toBeLessThanOrEqual(bands.p75);
  });

  it("refuses a plan whose stop or target is on the wrong side of the entry", () => {
    const flat = pool(() => FLAT);
    expect(() => resample({ ...LONG, stop: 100.5 }, flat, RUN)).toThrow(/stop/);
    expect(() => resample({ ...LONG, target: 99.5 }, flat, RUN)).toThrow(
      /target/,
    );
    expect(() => resample({ ...SHORT, stop: 99 }, flat, RUN)).toThrow(/stop/);
    expect(() => resample({ ...SHORT, target: 101 }, flat, RUN)).toThrow(
      /target/,
    );
  });

  it("refuses to run without sessions, or from a bar the session does not have", () => {
    const empty: SessionPool = {
      barsPerSession: BARS,
      sessions: [],
      excluded: [],
    };
    expect(() => resample(LONG, empty, RUN)).toThrow(/no sessions/);
    expect(() =>
      resample(
        { ...LONG, entryBar: BARS },
        pool(() => FLAT),
        RUN,
      ),
    ).toThrow(/entryBar/);
  });
});
