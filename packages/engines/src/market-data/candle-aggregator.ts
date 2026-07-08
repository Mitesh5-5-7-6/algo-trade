import type { Candle, CandleInterval, Tick } from "@neelkanth/core";

/** Interval durations in ms. */
const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "60m": 3_600_000,
};

export function intervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}

interface BarState {
  bucketStart: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Aggregates normalized ticks into OHLCV candles (plan/17 §5).
 *
 * Bucketing is `floor(ts / intervalMs) * intervalMs`, applied per interval to
 * the SAME tick stream. This is provably equivalent to the plan's "derive
 * higher intervals from 1m" intent (plan/17 §5): a 5m bucket partitions into
 * exactly its five 1m buckets over the identical ticks, so open/high/low/
 * close/volume agree at every edge by construction — there is one source and
 * one deterministic bucket assignment, so 1m and 5m can never disagree.
 *
 * Honesty rule (plan/17 §5): a bucket with zero ticks produces NO bar — absent
 * data is represented as absent, never fabricated as a flat bar. Ticks whose
 * volume field is already incremental are summed; a live normalizer converts
 * a broker's cumulative day-volume into deltas before producing the Tick.
 */
export class CandleAggregator {
  private readonly intervals: readonly CandleInterval[];
  private readonly bars = new Map<string, BarState>();

  constructor(intervals: readonly CandleInterval[]) {
    if (intervals.length === 0) {
      throw new Error("CandleAggregator requires at least one interval");
    }
    this.intervals = intervals;
  }

  private static key(symbol: string, interval: CandleInterval): string {
    return `${symbol}|${interval}`;
  }

  /**
   * Fold a tick into each interval's open bar. Returns any bars that CLOSED as
   * a result of this tick crossing a boundary (possibly several, across
   * intervals) — the caller persists them and emits CANDLE_CLOSED. An
   * out-of-order tick (older than the open bucket) is ignored; the engine's
   * monotonic guard normally prevents these, and the aggregator defends too.
   */
  addTick(tick: Tick): Candle[] {
    const closed: Candle[] = [];
    for (const interval of this.intervals) {
      const bucketStart =
        Math.floor(tick.ts / intervalMs(interval)) * intervalMs(interval);
      const key = CandleAggregator.key(tick.symbol, interval);
      const state = this.bars.get(key);

      if (state === undefined) {
        this.bars.set(key, this.startBar(bucketStart, tick));
      } else if (bucketStart > state.bucketStart) {
        closed.push(this.finalize(tick.symbol, interval, state));
        // Intermediate empty buckets produce no bar (honest absence).
        this.bars.set(key, this.startBar(bucketStart, tick));
      } else if (bucketStart === state.bucketStart) {
        state.high = Math.max(state.high, tick.ltp);
        state.low = Math.min(state.low, tick.ltp);
        state.close = tick.ltp;
        state.volume += tick.volume;
      }
      // bucketStart < state.bucketStart → out-of-order, ignored.
    }
    return closed;
  }

  /**
   * Close every open bar with the data it has (plan/17 §5 EOD, plan/13 §6):
   * used on MARKET_CLOSE. Clears state so the next session starts fresh.
   */
  flush(): Candle[] {
    const closed: Candle[] = [];
    for (const [key, state] of this.bars) {
      const [symbol, interval] = key.split("|") as [string, CandleInterval];
      closed.push(this.finalize(symbol, interval, state));
    }
    this.bars.clear();
    return closed;
  }

  private startBar(bucketStart: number, tick: Tick): BarState {
    return {
      bucketStart,
      open: tick.ltp,
      high: tick.ltp,
      low: tick.ltp,
      close: tick.ltp,
      volume: tick.volume,
    };
  }

  private finalize(
    symbol: string,
    interval: CandleInterval,
    state: BarState,
  ): Candle {
    return {
      symbol,
      interval,
      open: state.open,
      high: state.high,
      low: state.low,
      close: state.close,
      volume: state.volume,
      ts: state.bucketStart,
    };
  }
}
