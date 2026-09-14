import type { CandleInterval } from "@neelkanth/core";
import type { Broker } from "@neelkanth/broker";
import { CandleAggregator } from "./candle-aggregator.js";
import type { TickNormalizer } from "./normalize.js";
import type { MarketDataPorts } from "./ports.js";

/** The slice of the Broker the data side uses (plan/19 §2 "their slice"). */
export type MarketDataFeed = Pick<
  Broker,
  "onData" | "onConnectionChange" | "subscribe"
>;

export interface MarketDataEngineDeps {
  ports: MarketDataPorts;
  normalizer: TickNormalizer;
  intervals: readonly CandleInterval[];
  /**
   * Required error sink — the engine refuses to fail silently (plan/02 §10).
   * The composition root passes a logging fn; tests pass a capturing one.
   */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The Market Data Engine (plan/17): the system's entry point for market
 * reality. It normalizes raw broker messages into internal ticks, aggregates
 * candles, and publishes both. Everything downstream sees the market only
 * through this engine's output (plan/17 §1).
 *
 * Sole writer (plan/02 §8, plan/17 §3) of the `candles` collection, via
 * injected ports so the engine itself holds no infrastructure.
 *
 * It does NOT drive the session. The engine used to own a `pollSession` that
 * evaluated a SessionManager, wrote `hot:session` and emitted MARKET_OPEN /
 * MARKET_CLOSE — but nothing in production ever called it, because the runtime
 * drives the session itself on its own timer. Worse, the runtime injected its
 * OWN SessionManager instance here, and `evaluate()` consumes the open/close
 * edge: had anything called `pollSession`, it would have eaten the transition
 * the runtime's MARKET_OPEN/MARKET_CLOSE publishing depends on, and those
 * events would have silently stopped. Two session drivers sharing one stateful
 * manager is a trap, so there is now one driver — the runtime — and this engine
 * exposes `flushOpenBars` for it to call at the close.
 */
export class MarketDataEngine {
  private readonly ports: MarketDataPorts;
  private readonly normalizer: TickNormalizer;
  private readonly aggregator: CandleAggregator;
  private readonly onError: MarketDataEngineDeps["onError"];
  /** Per-symbol last applied timestamp — the monotonic guard (plan/17 §8). */
  private readonly lastTs = new Map<string, number>();
  private workingSet: string[] = [];
  private feed: MarketDataFeed | null = null;

  constructor(deps: MarketDataEngineDeps) {
    this.ports = deps.ports;
    this.normalizer = deps.normalizer;
    this.aggregator = new CandleAggregator(deps.intervals);
    this.onError = deps.onError;
  }

  /** Wire the broker's data side: raw messages in, resubscribe on reconnect. */
  attach(feed: MarketDataFeed): void {
    this.feed = feed;
    feed.onData((raw) => {
      void this.ingestRaw(raw);
    });
    feed.onConnectionChange((state) => {
      // Subscriptions do not survive a reconnect — re-establish the working
      // set on BROKER_CONNECTED (plan/17 §8, plan/19 §4).
      if (state === "connected") void this.resubscribe();
    });
  }

  /**
   * Set the working set of subscribed symbols — the union of enabled
   * strategies' symbols (plan/17 §7). Full enable/disable reactivity binds to
   * the Strategy Engine's config cache; here it is a direct setter.
   */
  async subscribe(symbols: readonly string[]): Promise<void> {
    this.workingSet = [...new Set(symbols)];
    if (this.feed && this.workingSet.length > 0) {
      await this.feed.subscribe(this.workingSet);
    }
  }

  private async resubscribe(): Promise<void> {
    if (this.feed && this.workingSet.length > 0) {
      try {
        await this.feed.subscribe(this.workingSet);
      } catch (error) {
        this.onError(error, { where: "resubscribe" });
      }
    }
  }

  /**
   * The tick path (plan/17 §4): normalize → monotonic guard → hot price →
   * publish MARKET_TICK → aggregate → persist/emit any closed candle. Never
   * rejects: all failures route to `onError`, so a bad message can't stall the
   * feed callback.
   */
  async ingestRaw(raw: unknown): Promise<void> {
    try {
      const tick = this.normalizer(raw);
      if (tick === null) {
        this.onError(new Error("unparseable market message"), { raw });
        return;
      }

      // Monotonic hot state (plan/17 §8): a tick older than or equal to the
      // last applied one for this symbol updates nothing.
      const last = this.lastTs.get(tick.symbol);
      if (last !== undefined && tick.ts <= last) return;
      this.lastTs.set(tick.symbol, tick.ts);

      // No Redis write here. `hot:price` is a cross-process convenience copy,
      // not the price the engine trades on — strategies, risk, PnL and the
      // paper broker all read the in-process price map. Writing it per tick
      // cost one Redis command per tick, ~96% of all command usage, for a key
      // production reads a handful of times a day. The runtime refreshes it on
      // candle close instead (plan/08 §5).
      await this.ports.publish("MARKET_TICK", tick);

      for (const candle of this.aggregator.addTick(tick)) {
        await this.ports.saveCandle(candle);
        await this.ports.publish("CANDLE_CLOSED", candle);
      }
    } catch (error) {
      this.onError(error, { where: "ingestRaw" });
    }
  }

  /**
   * Close every bar still open and persist it (plan/17 §5 EOD). Called by the
   * runtime's session driver on the open→closed transition, BEFORE it publishes
   * MARKET_CLOSE, so the day's last bar exists before anything reacts to the
   * close.
   *
   * Without this, a session's final bar sat in memory until the NEXT session's
   * first tick pushed the bucket forward — so it was either lost outright when
   * the process restarted overnight, or emitted the next morning as a
   * CANDLE_CLOSED carrying yesterday's timestamp, into a live open market,
   * where the exit engine judged stops against it and strategies decided on it.
   * A seventeen-hour-old bar arriving at 09:15 is not a stale cache entry; it
   * is a trading input.
   *
   * Idempotent: the aggregator clears its state, so a second call flushes
   * nothing. Never rejects — failures route to `onError`, because a failed
   * flush must not take down the session transition that called it.
   */
  async flushOpenBars(): Promise<void> {
    try {
      for (const candle of this.aggregator.flush()) {
        await this.ports.saveCandle(candle);
        await this.ports.publish("CANDLE_CLOSED", candle);
      }
    } catch (error) {
      this.onError(error, { where: "flushOpenBars" });
    }
  }
}
