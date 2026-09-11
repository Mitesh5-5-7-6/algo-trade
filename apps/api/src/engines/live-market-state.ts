/**
 * The live market state the process trades on — in memory, one copy.
 *
 * It exists because the Paper Broker is constructed before the engine runtime
 * (the runtime is handed the broker), yet both need the same prices. Before
 * this, the broker read `hot:price:{symbol}` out of Redis while every other
 * consumer — strategies, risk sizing, PnL — read an in-process map. Two
 * sources for one number is a correctness problem as much as a cost one: the
 * broker could fill at a price that risk had not sized against.
 *
 * Owned by the composition root, written by the engine runtime, read by the
 * Paper Broker. Deliberately a plain mutable holder rather than an event
 * emitter: every reader wants "the latest value now", which is exactly what a
 * map lookup is.
 */
export interface LiveMarketState {
  /** Latest traded price per symbol, updated on every tick and candle close. */
  readonly prices: Map<string, number>;
  /** Whether the exchange session is open, per the Session Manager. */
  sessionOpen: boolean;
}

export function createLiveMarketState(): LiveMarketState {
  return { prices: new Map(), sessionOpen: false };
}
