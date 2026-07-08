import { describe, expect, it } from "vitest";
import type { Candle, Tick } from "@neelkanth/core";
import { CandleAggregator, intervalMs } from "./candle-aggregator.js";

const tick = (ts: number, ltp: number, volume = 1): Tick => ({
  symbol: "NSE:RELIANCE-EQ",
  ltp,
  volume,
  ts,
});

describe("CandleAggregator (plan/17 §5)", () => {
  it("requires at least one interval", () => {
    expect(() => new CandleAggregator([])).toThrow();
  });

  it("keeps a bar open until a tick crosses the boundary, then closes it OHLCV-correct", () => {
    const agg = new CandleAggregator(["1m"]);
    expect(agg.addTick(tick(1_000, 100, 5))).toEqual([]); // opens [0,60000)
    expect(agg.addTick(tick(2_000, 110, 3))).toEqual([]); // high
    expect(agg.addTick(tick(3_000, 90, 2))).toEqual([]); // low, close 90

    const closed = agg.addTick(tick(61_000, 95, 4)); // crosses into [60000,120000)
    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual({
      symbol: "NSE:RELIANCE-EQ",
      interval: "1m",
      open: 100,
      high: 110,
      low: 90,
      close: 90,
      volume: 10,
      ts: 0,
    });
  });

  it("derives higher intervals consistently: a 5m bar equals its five 1m bars", () => {
    const oneM = new CandleAggregator(["1m"]);
    const fiveM = new CandleAggregator(["5m"]);
    const oneMClosed: Candle[] = [];
    // One tick mid-minute for minutes 0..4 — all within the first 5m bucket.
    const ticks: Tick[] = [];
    for (let i = 0; i < 5; i += 1) {
      ticks.push(tick(i * 60_000 + 30_000, 100 + i, i + 1));
    }

    for (const t of ticks) {
      oneMClosed.push(...oneM.addTick(t)); // closes bars 0..3 as minutes advance
      fiveM.addTick(t); // all in one 5m bucket, nothing closes yet
    }
    oneMClosed.push(...oneM.flush()); // the still-open minute-4 bar
    const fiveClosed = fiveM.flush(); // the single 5m bar

    expect(oneMClosed).toHaveLength(5);
    expect(fiveClosed).toHaveLength(1);
    const bar = fiveClosed[0];
    expect(bar?.open).toBe(oneMClosed[0]?.open); // 100
    expect(bar?.close).toBe(oneMClosed[4]?.close); // 104
    expect(bar?.high).toBe(Math.max(...oneMClosed.map((c) => c.high)));
    expect(bar?.low).toBe(Math.min(...oneMClosed.map((c) => c.low)));
    expect(bar?.volume).toBe(oneMClosed.reduce((s, c) => s + c.volume, 0)); // 15
  });

  it("produces NO bar for an empty bucket — honest absence (plan/17 §5)", () => {
    const agg = new CandleAggregator(["1m"]);
    agg.addTick(tick(1_000, 100)); // bucket 0
    // Jump straight to bucket 3 — buckets 1 and 2 saw no ticks.
    const closed = agg.addTick(tick(3 * 60_000 + 1_000, 105));
    expect(closed).toHaveLength(1); // only bucket 0 closes; 1 and 2 are absent
    expect(closed[0]?.ts).toBe(0);
  });

  it("ignores a tick from an already-closed earlier bucket", () => {
    // Within-bucket monotonicity is the ENGINE's guard (plan/17 §8); the
    // aggregator additionally defends at bucket granularity — a late tick from
    // a bucket that already closed changes nothing.
    const agg = new CandleAggregator(["1m"]);
    agg.addTick(tick(30_000, 100)); // opens bucket 0
    expect(agg.addTick(tick(61_000, 120))).toHaveLength(1); // closes bucket 0, opens bucket 1
    expect(agg.addTick(tick(20_000, 5))).toEqual([]); // bucket 0 again — ignored
    const [bar] = agg.flush(); // bucket 1, untouched by the late tick
    expect(bar?.open).toBe(120);
    expect(bar?.low).toBe(120);
  });

  it("flush closes every open bar and clears state", () => {
    const agg = new CandleAggregator(["1m", "5m"]);
    agg.addTick(tick(1_000, 100));
    expect(agg.flush()).toHaveLength(2); // one per interval
    expect(agg.flush()).toEqual([]); // state cleared
  });

  it("exposes interval durations", () => {
    expect(intervalMs("1m")).toBe(60_000);
    expect(intervalMs("15m")).toBe(900_000);
  });
});
