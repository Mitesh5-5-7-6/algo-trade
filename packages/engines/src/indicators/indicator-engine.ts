import type { Candle, CandleInterval } from "@neelkanth/core";
import type { Indicator } from "@neelkanth/indicators";
import type { IndicatorPorts, IndicatorSnapshot } from "./ports.js";

/**
 * A registered indicator with its generic state boxed away, so the engine can
 * hold heterogeneous indicators in one collection without `any`.
 */
interface RunningIndicator {
  readonly key: string;
  readonly sessionAnchored: boolean;
  readonly warmupBars: number;
  fold(bar: Candle): void;
  read(): Readonly<Record<string, number>> | null;
  ready(): boolean;
  reset(): void;
}

function toRunning<S>(spec: Indicator<S>): RunningIndicator {
  let state = spec.init();
  return {
    key: spec.key,
    sessionAnchored: spec.sessionAnchored,
    warmupBars: spec.warmupBars,
    fold(bar) {
      state = spec.fold(state, bar);
    },
    read: () => spec.read(state),
    ready: () => spec.ready(state),
    reset() {
      state = spec.init();
    },
  };
}

export interface IndicatorEngineDeps {
  ports: IndicatorPorts;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The Indicator Engine (plan/18): computes every derived value strategies
 * reason about, incrementally, in ONE place (plan/18 §2 — one source of truth
 * for the math, and deduplication: five strategies needing EMA(21) cost one
 * computation). Registration collects the union of required indicators keyed by
 * `(symbol, interval, key)`; the folds themselves live in `@neelkanth/indicators`.
 *
 * Infra-free via injected ports; sole writer of `hot:indicators:*` (plan/02 §8).
 */
export class IndicatorEngine {
  private readonly ports: IndicatorPorts;
  private readonly onError: IndicatorEngineDeps["onError"];
  /** `${symbol}|${interval}` → (indicator key → running indicator). */
  private readonly registry = new Map<string, Map<string, RunningIndicator>>();

  constructor(deps: IndicatorEngineDeps) {
    this.ports = deps.ports;
    this.onError = deps.onError;
  }

  private static seriesKey(symbol: string, interval: CandleInterval): string {
    return `${symbol}|${interval}`;
  }

  private bucket(
    symbol: string,
    interval: CandleInterval,
  ): Map<string, RunningIndicator> {
    const key = IndicatorEngine.seriesKey(symbol, interval);
    let bucket = this.registry.get(key);
    if (bucket === undefined) {
      bucket = new Map();
      this.registry.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Register an indicator for a `(symbol, interval)`. Deduplicated by key — a
   * second EMA(9) on the same series is a no-op (plan/18 §2). Generic per call
   * so heterogeneous indicators register type-safely.
   */
  register<S>(
    symbol: string,
    interval: CandleInterval,
    spec: Indicator<S>,
  ): void {
    const bucket = this.bucket(symbol, interval);
    if (!bucket.has(spec.key)) {
      bucket.set(spec.key, toRunning(spec));
    }
  }

  /**
   * Warm up one series from candle history (plan/18 §4): load
   * max(warmupBars) bars and replay them through the folds so recursive
   * indicators are correctly seeded before the first live decision.
   * Session-anchored indicators (VWAP) are SKIPPED — they must not carry
   * prior-session data across the bell (plan/18 §5); they start at MARKET_OPEN.
   * Writes the resulting hot snapshot but emits no event (warm-up is seeding,
   * not a live bar close, plan/18 §6).
   */
  async warmUp(symbol: string, interval: CandleInterval): Promise<void> {
    try {
      const bucket = this.registry.get(
        IndicatorEngine.seriesKey(symbol, interval),
      );
      if (bucket === undefined || bucket.size === 0) return;

      const rolling = [...bucket.values()].filter((i) => !i.sessionAnchored);
      const maxWarmup = rolling.reduce((m, i) => Math.max(m, i.warmupBars), 0);
      if (maxWarmup > 0) {
        const history = await this.ports.loadWarmupCandles(
          symbol,
          interval,
          maxWarmup,
        );
        for (const bar of history) {
          for (const indicator of rolling) indicator.fold(bar);
        }
      }
      await this.ports.writeHotIndicators(
        symbol,
        interval,
        this.snapshot(bucket),
      );
    } catch (error) {
      this.onError(error, { where: "warmUp", symbol, interval });
    }
  }

  /**
   * Fold a closed candle into its series' indicators, write the hot snapshot,
   * and emit INDICATORS_UPDATED (plan/18 §6). This runs BEFORE strategies
   * analyze the same bar (the lifecycle order of plan/15 §4), so `analyze()`
   * sees indicators that include the bar it is deciding on.
   */
  async onCandleClosed(candle: Candle): Promise<void> {
    try {
      const bucket = this.registry.get(
        IndicatorEngine.seriesKey(candle.symbol, candle.interval),
      );
      if (bucket === undefined || bucket.size === 0) return;

      for (const indicator of bucket.values()) indicator.fold(candle);

      const snapshot = this.snapshot(bucket);
      await this.ports.writeHotIndicators(
        candle.symbol,
        candle.interval,
        snapshot,
      );
      await this.ports.publish("INDICATORS_UPDATED", {
        symbol: candle.symbol,
        interval: candle.interval,
        indicators: snapshot.values,
        ts: candle.ts,
      });
    } catch (error) {
      this.onError(error, {
        where: "onCandleClosed",
        symbol: candle.symbol,
        interval: candle.interval,
      });
    }
  }

  /**
   * Reset session-anchored indicators at the bell (plan/18 §5): VWAP's
   * accumulators zero at MARKET_OPEN. Rolling indicators (EMA/RSI/ATR) are
   * untouched — their state spans days.
   */
  onMarketOpen(): void {
    for (const bucket of this.registry.values()) {
      for (const indicator of bucket.values()) {
        if (indicator.sessionAnchored) indicator.reset();
      }
    }
  }

  private snapshot(bucket: Map<string, RunningIndicator>): IndicatorSnapshot {
    const values: Record<string, number> = {};
    const ready: Record<string, boolean> = {};
    for (const indicator of bucket.values()) {
      ready[indicator.key] = indicator.ready();
      const read = indicator.read();
      if (read !== null) Object.assign(values, read);
    }
    return { values, ready };
  }
}
