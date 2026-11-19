import {
  intervalMs,
  isDailyInterval,
  type Candle,
  type CandleInterval,
  type Tick,
} from "@neelkanth/core";

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
  /**
   * Volume credited to a bucket whose bar has not opened yet — a future's tick
   * can land in a new minute a moment before the index's does.
   */
  private readonly pendingVolume = new Map<
    string,
    { bucketStart: number; volume: number }
  >();

  constructor(intervals: readonly CandleInterval[]) {
    if (intervals.length === 0) {
      throw new Error("CandleAggregator requires at least one interval");
    }
    // A daily bar is research data from the broker's history (§7.2 Q3). Built
    // from live ticks it would be bucketed from 05:30 IST and closed only by
    // the next day's first tick — a bar no strategy may ever decide on.
    const daily = intervals.find(isDailyInterval);
    if (daily !== undefined) {
      throw new Error(
        `CandleAggregator refuses the ${daily} interval: daily bars are research data, never built from live ticks`,
      );
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
        this.bars.set(key, this.startBar(key, bucketStart, tick));
      } else if (bucketStart > state.bucketStart) {
        closed.push(this.finalize(tick.symbol, interval, state));
        // Intermediate empty buckets produce no bar (honest absence).
        this.bars.set(key, this.startBar(key, bucketStart, tick));
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
    this.pendingVolume.clear();
    return closed;
  }

  /**
   * Credit volume traded elsewhere to `symbol`'s bar of the same bucket
   * (2026-11-18): an index has no traded volume of its own — every live
   * index bar arrived with volume 0, so VWAP and average volume never formed
   * — and its near-month future's volume stands in for it. Volume for a
   * bucket whose bar is already closed is dropped, never moved into a later
   * one; volume for one not yet opened waits for it.
   */
  addVolume(symbol: string, ts: number, volume: number): void {
    if (!(volume > 0)) return;
    for (const interval of this.intervals) {
      const bucketStart =
        Math.floor(ts / intervalMs(interval)) * intervalMs(interval);
      const key = CandleAggregator.key(symbol, interval);
      const state = this.bars.get(key);
      if (state !== undefined && state.bucketStart === bucketStart) {
        state.volume += volume;
        continue;
      }
      if (state !== undefined && bucketStart < state.bucketStart) continue;
      const pending = this.pendingVolume.get(key);
      this.pendingVolume.set(key, {
        bucketStart,
        volume:
          pending?.bucketStart === bucketStart
            ? pending.volume + volume
            : volume,
      });
    }
  }

  private startBar(key: string, bucketStart: number, tick: Tick): BarState {
    const pending = this.pendingVolume.get(key);
    let credited = 0;
    if (pending !== undefined && pending.bucketStart <= bucketStart) {
      if (pending.bucketStart === bucketStart) credited = pending.volume;
      this.pendingVolume.delete(key);
    }
    return {
      bucketStart,
      open: tick.ltp,
      high: tick.ltp,
      low: tick.ltp,
      close: tick.ltp,
      volume: tick.volume + credited,
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
      // This aggregator has exactly one input: the live tick feed. Stamping it
      // here rather than defaulting it downstream means a bar can never reach
      // storage without saying which producer made it.
      source: "LIVE_TICK",
    };
  }
}
