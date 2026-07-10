import type {
  CandleInterval,
  MarketContext,
  Signal,
  StrategyConfig,
  StrategyVerdict,
} from "@neelkanth/core";
import { indicatorKey } from "@neelkanth/indicators";
import type { RunnableStrategy, StrategyRegistry } from "@neelkanth/strategies";
import type { EventPayload } from "@neelkanth/contracts";
import { buildContext } from "./context-builder.js";
import type {
  IndicatorProvisioner,
  RiskHandoff,
  StrategyPorts,
} from "./ports.js";

/** A live per-(strategy, symbol) instance; state is private to the strategy. */
interface Instance {
  readonly strategyId: string;
  readonly symbol: string;
  readonly interval: CandleInterval;
  readonly strategy: RunnableStrategy;
  errored: boolean;
  errorCount: number;
}

export interface StrategyRunnerDeps {
  registry: StrategyRegistry;
  ports: StrategyPorts;
  /** Register + warm the strategy's indicators on enable (plan/18 §4). */
  provisionIndicators: IndicatorProvisioner;
  /** The synchronous risk→order path (plan/14 §2). */
  handoff: RiskHandoff;
  /** Fresh signal id per decision. */
  nextSignalId: () => string;
  /** Below this, a non-HOLD signal is recorded but not forwarded (plan/15 §6). */
  minConfidence?: number;
  /** Bars of context window handed to analyze. */
  candleWindow?: number;
  /** Auto-disable after this many consecutive analyze() throws (plan/15 §7). */
  maxErrors?: number;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The Strategy Engine runner (plan/15 §1, §4): hosts every enabled strategy,
 * feeds each a complete context on every relevant candle, collects the signals
 * they emit, and hands them — synchronously — to risk.
 *
 * It decides on INDICATORS_UPDATED, not the raw candle (plan/18 §6), so
 * `analyze()` always sees indicators that include the bar it is deciding on.
 * Infra-free via injected ports; sole writer of `signals` (plan/02 §8).
 */
export class StrategyRunner {
  private readonly deps: StrategyRunnerDeps;
  private readonly minConfidence: number;
  private readonly candleWindow: number;
  private readonly maxErrors: number;
  /** `${strategyId}|${symbol}` → instance. */
  private readonly instances = new Map<string, Instance>();
  /** Latest closed candle per `${symbol}|${interval}` (matched by ts). */
  private readonly latestCandle = new Map<
    string,
    EventPayload<"CANDLE_CLOSED">
  >();

  constructor(deps: StrategyRunnerDeps) {
    this.deps = deps;
    this.minConfidence = deps.minConfidence ?? 0;
    this.candleWindow = deps.candleWindow ?? 50;
    this.maxErrors = deps.maxErrors ?? 5;
  }

  private static seriesKey(symbol: string, interval: CandleInterval): string {
    return `${symbol}|${interval}`;
  }

  /**
   * Enable a strategy (plan/15 §4): validate params (in the registry), create
   * one instance per configured symbol, and provision its indicators. An
   * unknown type throws loudly here, not at runtime.
   */
  async enable(config: StrategyConfig): Promise<void> {
    if (!this.deps.registry.has(config.type)) {
      throw new Error(`unknown strategy type: ${config.type}`);
    }
    for (const symbol of config.symbols) {
      const strategy = this.deps.registry.instantiate(
        config.type,
        config.params,
        symbol,
      );
      this.instances.set(`${config.strategyId}|${symbol}`, {
        strategyId: config.strategyId,
        symbol,
        interval: strategy.interval,
        strategy,
        errored: false,
        errorCount: 0,
      });
      await this.deps.provisionIndicators(
        symbol,
        strategy.interval,
        strategy.requiredIndicators(),
      );
    }
  }

  /** Disable a strategy: drop all its per-symbol instances. */
  disable(strategyId: string): void {
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${strategyId}|`)) this.instances.delete(key);
    }
  }

  /** Cache the just-closed bar so the indicator update can be matched to it. */
  onCandleClosed(candle: EventPayload<"CANDLE_CLOSED">): void {
    this.latestCandle.set(
      StrategyRunner.seriesKey(candle.symbol, candle.interval),
      candle,
    );
  }

  /**
   * The heartbeat (plan/15 §4): on INDICATORS_UPDATED, build the context and
   * run every ready strategy for that series. Never rejects — failures route
   * to onError.
   */
  async onIndicatorsUpdated(
    payload: EventPayload<"INDICATORS_UPDATED">,
  ): Promise<void> {
    try {
      const interval = payload.interval as CandleInterval;
      const seriesKey = StrategyRunner.seriesKey(payload.symbol, interval);
      const candle = this.latestCandle.get(seriesKey);
      // Only decide on the bar the indicators were computed for.
      if (candle === undefined || candle.ts !== payload.ts) return;

      const instances = [...this.instances.values()].filter(
        (i) =>
          i.symbol === payload.symbol && i.interval === interval && !i.errored,
      );
      if (instances.length === 0) return;

      // Session gating (plan/15 §4): strategies decide only while open.
      const session = await this.deps.ports.readSession();
      if (session.phase !== "open") return;

      const candles = await this.deps.ports.readCandleWindow(
        payload.symbol,
        interval,
        this.candleWindow,
      );
      const sentiment = await this.deps.ports.readSentiment(payload.symbol);

      for (const instance of instances) {
        // Readiness gating (plan/18 §4): every required indicator present.
        const required = instance.strategy.requiredIndicators();
        const allReady = required.every(
          (spec) => indicatorKey(spec) in payload.indicators,
        );
        if (!allReady) continue;

        const position = await this.deps.ports.readPosition(
          instance.strategyId,
          payload.symbol,
        );
        const context = buildContext({
          symbol: payload.symbol,
          interval,
          candle,
          candles,
          indicators: payload.indicators,
          session,
          position,
          sentiment,
        });

        await this.runOne(instance, context, candle.ts);
      }
    } catch (error) {
      this.deps.onError(error, { where: "onIndicatorsUpdated" });
    }
  }

  /** Analyze one instance, record the signal, and forward if actionable. */
  private async runOne(
    instance: Instance,
    context: MarketContext,
    ts: number,
  ): Promise<void> {
    let verdict: StrategyVerdict;
    try {
      verdict = instance.strategy.analyze(context); // pure; may throw (plan/15 §7)
    } catch (error) {
      instance.errorCount += 1;
      if (instance.errorCount >= this.maxErrors) instance.errored = true;
      this.deps.onError(error, {
        where: "analyze",
        strategyId: instance.strategyId,
        symbol: instance.symbol,
        errored: instance.errored,
      });
      return;
    }
    instance.errorCount = 0;

    const signal = this.toSignal(instance, verdict, context, ts);
    await this.deps.ports.persistSignal(signal);
    await this.deps.ports.publish(
      "SIGNAL_CREATED",
      {
        signalId: signal.signalId,
        strategyId: signal.strategyId,
        symbol: signal.symbol,
        side: signal.side,
        confidence: signal.confidence,
        contextSnapshot: signal.contextSnapshot,
        ts: signal.ts,
      },
      signal.signalId,
    );

    // HOLD documents that the strategy looked and chose inaction (plan/15 §4);
    // it never proceeds to risk. Below-threshold signals are recorded but not
    // forwarded (plan/15 §6).
    if (verdict.side === "HOLD") return;
    if (verdict.confidence < this.minConfidence) return;

    await this.deps.handoff(signal); // synchronous risk→order (plan/14 §2)
  }

  private toSignal(
    instance: Instance,
    verdict: StrategyVerdict,
    context: MarketContext,
    ts: number,
  ): Signal {
    return {
      signalId: this.deps.nextSignalId(),
      strategyId: instance.strategyId,
      symbol: instance.symbol,
      side: verdict.side,
      confidence: verdict.confidence,
      ...(verdict.qtyProposal === undefined
        ? {}
        : { qtyProposal: verdict.qtyProposal }),
      ...(verdict.stopLoss === undefined ? {} : { stopLoss: verdict.stopLoss }),
      ...(verdict.target === undefined ? {} : { target: verdict.target }),
      reason: verdict.reason,
      contextSnapshot: {
        price: context.candle.close,
        indicators: context.indicators,
        session: context.session.phase,
        sentiment: context.sentiment,
      },
      ts,
    };
  }
}
