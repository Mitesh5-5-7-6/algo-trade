import type { CandleInterval } from "@neelkanth/core";
import type { EventName } from "./events.js";

/**
 * Pub/Sub channel-name builders (plan/08 §3 conventions). Channel names are
 * part of the bus contract, so they live here; Redis DATA-key builders
 * (hot:, cache:, risk:, …) belong to the `redis` package (plan/25 §3).
 */

/** `events:{EVENT_NAME}` — pipeline events. */
export function eventChannel(name: EventName): string {
  return `events:${name}`;
}

/** `market:tick:{symbol}` — normalized ticks. */
export function marketTickChannel(symbol: string): string {
  return `market:tick:${symbol}`;
}

/** `market:candle:{symbol}:{interval}` — closed candles. */
export function marketCandleChannel(
  symbol: string,
  interval: CandleInterval,
): string {
  return `market:candle:${symbol}:${interval}`;
}
