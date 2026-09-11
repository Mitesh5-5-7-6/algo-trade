import {
  UNKNOWN_MARKET_VIEW,
  type Candle,
  type CandleInterval,
  type MarketView,
} from "@neelkanth/core";
import { computeMarketView, type MarketBiasConfig } from "./market-bias.js";

export interface MarketBiasPorts {
  /** The recent window for a symbol (oldest→newest), as the runtime holds it. */
  readCandleWindow(
    symbol: string,
    interval: CandleInterval,
    count: number,
  ): Promise<Candle[]>;
}

export interface MarketBiasEngineDeps {
  ports: MarketBiasPorts;
  /**
   * Index symbols read for direction, e.g. `NSE:NIFTY50-INDEX`.
   *
   * Resolved on each refresh rather than captured once: the traded universe
   * changes whenever the operator enables or disables a strategy, and a list
   * captured at construction would silently keep measuring yesterday's
   * symbols.
   */
  indexSymbols: () => readonly string[];
  /** Instruments counted for participation — the traded universe. */
  breadthSymbols: () => readonly string[];
  interval?: CandleInterval;
  bars?: number;
  config?: MarketBiasConfig;
  now?: () => number;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * Keeps the market view current (plan/14 §4).
 *
 * Recomputed on candle close and **cached**, because the Risk Engine reads it
 * synchronously on the critical path (plan/02 §6, Regime A) and must not do
 * per-signal work there. The view is a property of the market, not of a
 * signal — every strategy deciding on the same bar sees the same one.
 *
 * On any failure the cached view is left alone rather than cleared: a
 * momentarily unreadable market should not flip the gate open or shut. The
 * boot value is NEUTRAL, which blocks nothing (see `UNKNOWN_MARKET_VIEW`).
 */
export class MarketBiasEngine {
  private readonly deps: MarketBiasEngineDeps;
  private readonly interval: CandleInterval;
  private readonly bars: number;
  private readonly now: () => number;
  private view: MarketView = UNKNOWN_MARKET_VIEW;

  constructor(deps: MarketBiasEngineDeps) {
    this.deps = deps;
    this.interval = deps.interval ?? "5m";
    this.bars = deps.bars ?? 90;
    this.now = deps.now ?? (() => Date.now());
  }

  /** The cached view — what the risk gate reads. Never throws. */
  current(): MarketView {
    return this.view;
  }

  /** Recompute from the current windows. Never rejects; errors route to onError. */
  async refresh(): Promise<void> {
    try {
      const load = async (
        symbols: readonly string[],
      ): Promise<Map<string, readonly Candle[]>> => {
        const out = new Map<string, readonly Candle[]>();
        for (const symbol of symbols) {
          const candles = await this.deps.ports.readCandleWindow(
            symbol,
            this.interval,
            this.bars,
          );
          if (candles.length > 0) out.set(symbol, candles);
        }
        return out;
      };
      this.view = computeMarketView({
        indexCandles: await load(this.deps.indexSymbols()),
        breadthCandles: await load(this.deps.breadthSymbols()),
        now: this.now(),
        ...(this.deps.config === undefined ? {} : { config: this.deps.config }),
      });
    } catch (error) {
      this.deps.onError(error, { where: "MarketBiasEngine.refresh" });
    }
  }
}
