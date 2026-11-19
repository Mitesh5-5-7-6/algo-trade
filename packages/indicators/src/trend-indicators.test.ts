import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import { bollinger, macd, supertrend, type Indicator } from "./index.js";

/** Supertrend, MACD and Bollinger (operator request 2026-11-18). */

const bar = (close: number, i: number, spread = 2): Candle => ({
  symbol: "NSE:X-EQ",
  interval: "5m",
  source: "LIVE_TICK",
  open: close,
  high: close + spread,
  low: close - spread,
  close,
  volume: 100,
  ts: 1_000_000 + i * 300_000,
});

function run<S>(
  indicator: Indicator<S>,
  closes: readonly number[],
): (Readonly<Record<string, number>> | null)[] {
  let state = indicator.init();
  return closes.map((close, i) => {
    state = indicator.fold(state, bar(close, i));
    return indicator.read(state);
  });
}

/** A plain EMA, SMA-seeded — written here independently of the fold. */
function referenceEma(
  values: readonly number[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = [];
  let e: number | null = null;
  const alpha = 2 / (period + 1);
  values.forEach((v, i) => {
    if (i + 1 < period) return out.push(null);
    if (e === null)
      e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else e = alpha * v + (1 - alpha) * e;
    return out.push(e);
  });
  return out;
}

const WAVE = Array.from(
  { length: 80 },
  (_, i) => Math.round((100 + 10 * Math.sin(i / 5) + i * 0.3) * 100) / 100,
);

describe("MACD", () => {
  it("is the fast EMA less the slow one, with an EMA of that as its signal", () => {
    const out = run(macd(3, 6, 4), WAVE);
    const fast = referenceEma(WAVE, 3);
    const slow = referenceEma(WAVE, 6);
    const line = WAVE.map((_, i) => {
      const f = fast[i];
      const s = slow[i];
      return f == null || s == null ? null : f - s;
    });
    const defined = line.filter((v): v is number => v !== null);
    const signal = referenceEma(defined, 4);
    const firstLine = line.findIndex((v) => v !== null);
    for (let i = 0; i < WAVE.length; i += 1) {
      const sig = i < firstLine ? null : signal[i - firstLine];
      const got = out[i];
      if (sig == null) {
        expect(got, `bar ${String(i)}`).toBeNull();
        continue;
      }
      expect(got?.["macd3_6_4"]).toBeCloseTo(line[i] ?? NaN, 9);
      expect(got?.["macd3_6_4signal"]).toBeCloseTo(sig, 9);
      expect(got?.["macd3_6_4hist"]).toBeCloseTo((line[i] ?? NaN) - sig, 9);
    }
    // Ready exactly when the signal line has seeded: slow + signal − 1 bars.
    expect(out.findIndex((v) => v !== null)).toBe(6 + 4 - 2);
  });

  it("is zero on a flat series and refuses a fast period not shorter than the slow", () => {
    const last = run(macd(), Array<number>(60).fill(100)).at(-1);
    expect(last?.["macd12_26_9"]).toBeCloseTo(0, 12);
    expect(last?.["macd12_26_9hist"]).toBeCloseTo(0, 12);
    expect(() => macd(26, 12)).toThrow(/shorter/);
  });
});

describe("Bollinger bands", () => {
  it("are the mean of the window ± k population standard deviations", () => {
    const out = run(bollinger(5, 2), [1, 2, 3, 4, 5, 6]);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    // Window 1..5: mean 3, population sd √2.
    expect(out[4]).toEqual({
      bb5x2: 3,
      bb5x2upper: 3 + 2 * Math.SQRT2,
      bb5x2lower: 3 - 2 * Math.SQRT2,
    });
    // It rolls: window 2..6.
    expect(out[5]?.["bb5x2"]).toBe(4);
  });

  it("collapse onto the mean when nothing moves", () => {
    const last = run(bollinger(), Array<number>(25).fill(250)).at(-1);
    expect(last).toEqual({ bb20x2: 250, bb20x2upper: 250, bb20x2lower: 250 });
  });
});

describe("Supertrend", () => {
  it("reads up, below price, in a steady rise — and down, above price, in a steady fall", () => {
    const rise = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    const up = run(supertrend(10, 3), rise).at(-1);
    expect(up?.["supertrend10x3dir"]).toBe(1);
    expect(up?.["supertrend10x3"]).toBeLessThan(rise.at(-1) ?? 0);

    const fall = Array.from({ length: 40 }, (_, i) => 200 - i * 2);
    const down = run(supertrend(10, 3), fall).at(-1);
    expect(down?.["supertrend10x3dir"]).toBe(-1);
    expect(down?.["supertrend10x3"]).toBeGreaterThan(fall.at(-1) ?? 0);
  });

  it("flips when price crosses the band, and only then", () => {
    const series = [
      ...Array.from({ length: 30 }, (_, i) => 100 + i), // up to 129
      ...Array.from({ length: 30 }, (_, i) => 128 - i * 3), // a sharp fall
    ];
    const dirs = run(supertrend(10, 3), series).map(
      (v) => v?.["supertrend10x3dir"] ?? null,
    );
    const flips = dirs.flatMap((d, i) =>
      i > 0 && d !== null && dirs[i - 1] !== null && d !== dirs[i - 1]
        ? [i]
        : [],
    );
    expect(flips).toHaveLength(1);
    expect(dirs[29]).toBe(1);
    expect(dirs.at(-1)).toBe(-1);
  });

  it("holds its band while the trend holds: the up band never falls", () => {
    const rise = Array.from(
      { length: 40 },
      (_, i) => 100 + i + (i % 3 === 0 ? -1.5 : 0),
    );
    const lines = run(supertrend(10, 3), rise)
      .map((v) => v?.["supertrend10x3"])
      .filter((v): v is number => v !== undefined);
    for (let i = 1; i < lines.length; i += 1)
      expect(lines[i]).toBeGreaterThanOrEqual(lines[i - 1] ?? Infinity);
  });

  it("waits for its ATR, and refuses a bad period or multiplier", () => {
    const out = run(
      supertrend(10, 3),
      Array.from({ length: 12 }, (_, i) => 100 + i),
    );
    expect(out.slice(0, 9)).toEqual(Array<null>(9).fill(null));
    expect(out[9]).not.toBeNull();
    expect(() => supertrend(0, 3)).toThrow(/period/);
    expect(() => supertrend(10, 0)).toThrow(/multiplier/);
  });
});
