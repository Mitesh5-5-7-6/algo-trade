import { intervalMs, type Candle, type CandleInterval } from "@neelkanth/core";
import type { HistoryProvider } from "@neelkanth/broker";

/**
 * The session's missed bars, fetched from the broker's history when the feed
 * comes up late (design LIVE_READINESS_AND_EXTENSIONS §2, task 15.3).
 *
 * The feed cannot deliver a bar from before it connected, and it connects only
 * once the operator has logged in: on 2026-11-18 the token arrived at 09:29,
 * the first live bar was 09:25 (built from 09:29's ticks alone), and every
 * strategy reading the opening range read one partial bar of three. The
 * exchange's own record of those minutes exists the whole time — this asks
 * for it.
 *
 * **Bars, not events.** What comes back is stored, at BROKER_HISTORICAL's
 * rank — which outranks, and so replaces, a partial LIVE_TICK bar of the same
 * bucket — and the caller reloads its candle windows from the store, which now holds
 * the better bar of each bucket. It is
 * never published as CANDLE_CLOSED: a strategy that saw 09:15's breakout as a
 * new bar at 09:40 would trade a price that is twenty-five minutes gone.
 *
 * Only closed buckets are asked for: the bucket the clock is in is still being
 * built by the live feed, and history would hand back its first minutes as if
 * they were the bar.
 */

export interface CatchUpRequest {
  now: number;
  /** Epoch ms of today's open. Nothing before it is asked for. */
  sessionOpenTs: number;
  symbols: readonly string[];
  intervals: readonly CandleInterval[];
}

export interface CatchUpDeps {
  history: Pick<HistoryProvider, "getHistory">;
  /** The rank-conditional upsert: true when applied, false when outranked. */
  save: (candle: Candle) => Promise<boolean>;
}

export interface CatchUpItem {
  symbol: string;
  interval: CandleInterval;
  /** Bars the broker returned for the window. */
  fetched: number;
  /** Of those, how many were written (a better bar may already be stored). */
  stored: number;
  /** Set when the fetch or the write failed; the other items still ran. */
  error?: string;
}

/**
 * The window of closed buckets since the open, `[from, to)`, or null when not
 * one bucket has closed yet.
 */
export function closedWindow(
  now: number,
  sessionOpenTs: number,
  interval: CandleInterval,
): { fromTs: number; toTs: number } | null {
  const width = intervalMs(interval);
  const toTs = Math.floor(now / width) * width;
  return toTs > sessionOpenTs ? { fromTs: sessionOpenTs, toTs } : null;
}

/**
 * Fetch and store each symbol's closed bars since the open, one request at a
 * time (the provider's limiter paces them). A failure is recorded against its
 * symbol and interval and the rest carry on: one illiquid option with no
 * history must not cost the index its opening range.
 */
export async function catchUpSession(
  request: CatchUpRequest,
  deps: CatchUpDeps,
): Promise<CatchUpItem[]> {
  const items: CatchUpItem[] = [];
  for (const symbol of request.symbols) {
    for (const interval of request.intervals) {
      const window = closedWindow(request.now, request.sessionOpenTs, interval);
      if (window === null) continue;
      const item: CatchUpItem = { symbol, interval, fetched: 0, stored: 0 };
      try {
        const result = await deps.history.getHistory({
          symbol,
          interval,
          ...window,
        });
        item.fetched = result.candles.length;
        for (const candle of result.candles) {
          if (await deps.save(candle)) item.stored += 1;
        }
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
      }
      items.push(item);
    }
  }
  return items;
}
