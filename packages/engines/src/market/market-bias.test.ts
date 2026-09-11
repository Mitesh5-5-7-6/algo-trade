import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import { computeMarketView, readIndex } from "./market-bias.js";

const SYM = "NSE:NIFTY50-INDEX";

/** A series of closes as 5m bars; `volume` 0 mimics a spot index feed. */
function series(closes: readonly number[], volume = 0): Candle[] {
  return closes.map((close, i) => ({
    symbol: SYM,
    interval: "5m" as const,
    open: closes[i - 1] ?? close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
    ts: i * 300_000,
  }));
}

/** A day's move for one instrument: first open → last close. */
function dayMove(open: number, close: number): Candle[] {
  return [
    {
      symbol: "NSE:X-EQ",
      interval: "5m",
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 100,
      ts: 0,
    },
  ];
}

describe("readIndex", () => {
  it("is bullish when price sits above its own trend", () => {
    const read = readIndex(SYM, series([100, 101, 102, 103, 104, 105, 106]));
    expect(read?.bias).toBe("BULLISH");
  });

  it("is bearish when price sits below its own trend", () => {
    const read = readIndex(SYM, series([106, 105, 104, 103, 102, 101, 100]));
    expect(read?.bias).toBe("BEARISH");
  });

  it("returns null before there are enough bars to read", () => {
    expect(readIndex(SYM, series([100, 101]))).toBeNull();
  });

  /**
   * A spot index feed carries no volume, so VWAP is unavailable. It must be
   * treated as missing evidence rather than as disagreement — otherwise every
   * index read is NEUTRAL and the gate silently never fires.
   */
  it("reads on trend alone when the feed has no volume", () => {
    const read = readIndex(SYM, series([100, 101, 102, 103, 104, 105, 106], 0));
    expect(read?.vwap).toBeUndefined();
    expect(read?.bias).toBe("BULLISH");
  });

  it("is neutral when price is above trend but below VWAP", () => {
    // Rising into the window, then sold off: last close above the EMA of a
    // rising series is false, so build the opposite — high VWAP, low close.
    const candles = series([100, 120, 121, 122, 118, 110, 106], 1000);
    const read = readIndex(SYM, candles);
    expect(read?.vwap).toBeDefined();
    // close 106 < vwap (~116) and < ema → BEARISH, not a disagreement.
    expect(read?.bias).toBe("BEARISH");
  });
});

describe("computeMarketView — agreement between direction and participation", () => {
  const bullIndex = new Map([[SYM, series([100, 101, 102, 103, 104, 105, 106])]]);
  const bearIndex = new Map([[SYM, series([106, 105, 104, 103, 102, 101, 100])]]);

  const broadUp = new Map([
    ["a", dayMove(100, 105)],
    ["b", dayMove(100, 104)],
    ["c", dayMove(100, 103)],
    ["d", dayMove(100, 99)],
  ]); // 3↑/1↓ = 75% ≥ 60%
  const broadDown = new Map([
    ["a", dayMove(100, 95)],
    ["b", dayMove(100, 96)],
    ["c", dayMove(100, 97)],
    ["d", dayMove(100, 101)],
  ]); // 1↑/3↓ = 25% ≤ 40%
  const mixed = new Map([
    ["a", dayMove(100, 105)],
    ["b", dayMove(100, 95)],
  ]); // 50% — neither

  it("is BULLISH when the index rises and most instruments are up", () => {
    const v = computeMarketView({
      indexCandles: bullIndex,
      breadthCandles: broadUp,
      now: 1,
    });
    expect(v.bias).toBe("BULLISH");
    expect(v.advancing).toBe(3);
    expect(v.declining).toBe(1);
  });

  it("is BEARISH when the index falls and most instruments are down", () => {
    const v = computeMarketView({
      indexCandles: bearIndex,
      breadthCandles: broadDown,
      now: 1,
    });
    expect(v.bias).toBe("BEARISH");
  });

  /**
   * The failure each half is blind to: an index carried up by a couple of
   * heavyweights while the majority of stocks fall reads bullish and trades
   * badly. Requiring agreement is what makes the verdict worth blocking on.
   */
  it("is NEUTRAL when the index rises but breadth is falling", () => {
    const v = computeMarketView({
      indexCandles: bullIndex,
      breadthCandles: broadDown,
      now: 1,
    });
    expect(v.indexBias).toBe("BULLISH");
    expect(v.breadthBias).toBe("BEARISH");
    expect(v.bias).toBe("NEUTRAL");
  });

  it("is NEUTRAL on an even split of participation", () => {
    const v = computeMarketView({
      indexCandles: bullIndex,
      breadthCandles: mixed,
      now: 1,
    });
    expect(v.breadthBias).toBe("NEUTRAL");
    expect(v.bias).toBe("NEUTRAL");
  });

  it("is NEUTRAL when the indices disagree with each other", () => {
    const v = computeMarketView({
      indexCandles: new Map([
        [SYM, series([100, 101, 102, 103, 104, 105, 106])],
        ["NSE:NIFTYBANK-INDEX", series([106, 105, 104, 103, 102, 101, 100])],
      ]),
      breadthCandles: broadUp,
      now: 1,
    });
    expect(v.indexBias).toBe("NEUTRAL");
    expect(v.bias).toBe("NEUTRAL");
  });

  it("degrades to the unknown view with no data at all", () => {
    const v = computeMarketView({
      indexCandles: new Map(),
      breadthCandles: new Map(),
      now: 42,
    });
    expect(v.bias).toBe("NEUTRAL");
    expect(v.detail).toBe("no market data yet");
    expect(v.ts).toBe(42);
  });

  it("carries a detail line naming both halves, for the audit log", () => {
    const v = computeMarketView({
      indexCandles: bullIndex,
      breadthCandles: broadUp,
      now: 1,
    });
    expect(v.detail).toContain("index BULLISH");
    expect(v.detail).toContain("3↑/1↓");
  });
});
