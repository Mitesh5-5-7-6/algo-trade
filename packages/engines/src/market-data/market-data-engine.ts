import type { CandleInterval } from "@neelkanth/core";
import type { Broker } from "@neelkanth/broker";
import { CandleAggregator } from "./candle-aggregator.js";
import { istDateKey, SessionManager } from "./session-manager.js";
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
  /** Injected session manager (defaults to NSE hours). */
  session?: SessionManager;
  exchange?: string;
  /**
   * Required error sink — the engine refuses to fail silently (plan/02 §10).
   * The composition root passes a logging fn; tests pass a capturing one.
   */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The Market Data Engine (plan/17): the system's entry point for market
 * reality. It normalizes raw broker messages into internal ticks, maintains
 * the hot price snapshot, aggregates candles, tracks the session, and
 * publishes all of it. Everything downstream sees the market only through this
 * engine's output (plan/17 §1).
 *
 * Sole writer (plan/02 §8, plan/17 §3) of `hot:price:*`, `hot:session`, and
 * the `candles` collection — all via injected ports so the engine itself holds
 * no infrastructure.
 */
export class MarketDataEngine {
  private readonly ports: MarketDataPorts;
  private readonly normalizer: TickNormalizer;
  private readonly aggregator: CandleAggregator;
  private readonly session: SessionManager;
  private readonly exchange: string;
  private readonly onError: MarketDataEngineDeps["onError"];
  /** Per-symbol last applied timestamp — the monotonic guard (plan/17 §8). */
  private readonly lastTs = new Map<string, number>();
  private workingSet: string[] = [];
  private feed: MarketDataFeed | null = null;

  constructor(deps: MarketDataEngineDeps) {
    this.ports = deps.ports;
    this.normalizer = deps.normalizer;
    this.aggregator = new CandleAggregator(deps.intervals);
    this.session = deps.session ?? new SessionManager();
    this.exchange = deps.exchange ?? "NSE";
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

      await this.ports.writeHotPrice(tick.symbol, tick);
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
   * Evaluate the session at `now` and drive its side effects (plan/17 §6):
   * write `hot:session` on a phase change, emit MARKET_OPEN, and on
   * MARKET_CLOSE flush any open bars before emitting close. Driven by a timer
   * at the composition root; the injected clock keeps it deterministic.
   */
  async pollSession(now: number): Promise<void> {
    try {
      const evaluation = this.session.evaluate(now);
      if (evaluation.phaseChanged) {
        await this.ports.writeHotSession(evaluation.phase);
      }
      if (evaluation.marketOpened) {
        await this.ports.publish("MARKET_OPEN", {
          exchange: this.exchange,
          session: istDateKey(now),
          ts: now,
        });
      }
      if (evaluation.marketClosed) {
        for (const candle of this.aggregator.flush()) {
          await this.ports.saveCandle(candle);
          await this.ports.publish("CANDLE_CLOSED", candle);
        }
        await this.ports.publish("MARKET_CLOSE", {
          exchange: this.exchange,
          session: istDateKey(now),
          ts: now,
        });
      }
    } catch (error) {
      this.onError(error, { where: "pollSession" });
    }
  }
}
