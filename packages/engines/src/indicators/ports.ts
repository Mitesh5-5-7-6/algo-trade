import type { Candle, CandleInterval } from "@neelkanth/core";
import type { PublishFn } from "../market-data/ports.js";

/** A written indicator snapshot: ready values + per-indicator readiness. */
export interface IndicatorSnapshot {
  values: Readonly<Record<string, number>>;
  ready: Readonly<Record<string, boolean>>;
}

/**
 * The infrastructure the Indicator Engine writes through, injected so the
 * engine stays infra-free and unit-testable (plan/05 §3). The composition
 * root implements these with the `redis` hot store and the `db` candles
 * repository; tests pass in-memory fakes.
 */
export interface IndicatorPorts {
  /** Write `hot:indicators:{symbol}` incl. the per-indicator ready flag (plan/18 §4). */
  writeHotIndicators(
    symbol: string,
    interval: CandleInterval,
    snapshot: IndicatorSnapshot,
  ): Promise<void>;
  /** Load the last `limit` candles for warm-up replay (plan/18 §4). */
  loadWarmupCandles(
    symbol: string,
    interval: CandleInterval,
    limit: number,
  ): Promise<Candle[]>;
  publish: PublishFn;
}
