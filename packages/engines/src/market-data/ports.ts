import type { Candle, SessionPhase, Tick } from "@neelkanth/core";
import type { EventName, EventPayload } from "@neelkanth/contracts";

/** Typed publish, structurally matching the redis EventBus (plan/09). */
export type PublishFn = <N extends EventName>(
  name: N,
  payload: EventPayload<N>,
  correlationId?: string,
) => Promise<void>;

/**
 * The infrastructure the Market Data Engine writes through, injected so the
 * engine stays infra-free and unit-testable (plan/05 §3 dependency injection).
 * The composition root implements these with the `redis` hot store + event bus
 * and the `db` candles repository; tests pass in-memory fakes.
 *
 * These map exactly to the engine's sole-writer ownership (plan/02 §8,
 * plan/17 §3): `hot:price:*`, `hot:session`, the `candles` collection.
 */
export interface MarketDataPorts {
  /** Write the live price snapshot `hot:price:{symbol}` (plan/08 §5). */
  writeHotPrice(symbol: string, tick: Tick): Promise<void>;
  /** Write `hot:session` (plan/08 §5, plan/17 §6). */
  writeHotSession(phase: SessionPhase): Promise<void>;
  /** Persist a closed bar to `candles` (plan/07); unique on symbol/interval/ts. */
  saveCandle(candle: Candle): Promise<void>;
  /** Publish a pipeline/market event over the bus (plan/09). */
  publish: PublishFn;
}
