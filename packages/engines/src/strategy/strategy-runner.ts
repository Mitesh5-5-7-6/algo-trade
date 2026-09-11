import type {
  CandleInterval,
  DerivativeTarget,
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

  /**
   * The derivative targets currently live, one per (strategy, symbol).
   *
   * The composition root needs these to keep the relevant contracts
   * SUBSCRIBED: a contract resolved at signal time is useless if it has never
   * ticked, because there is no price to size or fill against. Exposing the
   * targets lets the runtime track the at-the-money contracts continuously,
   * so by the time a signal fires the price is already there.
   */
  derivativeTargets(): { symbol: string; target: DerivativeTarget }[] {
    const out: { symbol: string; target: DerivativeTarget }[] = [];
    for (const instance of this.instances.values()) {
      const target = instance.strategy.derivative();
      if (target !== null) out.push({ symbol: instance.symbol, target });
    }
    return out;
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

    const trade = this.resolveTrade(instance, verdict, context, ts);
    if (trade === null) {
      // Recorded as a HOLD so the evaluation is not lost — the strategy DID
      // decide, and a silent drop would read as "the strategy never ran".
      const reason = `contract unresolved or unpriced: ${verdict.reason}`;
      await this.deps.ports.persistSignal(
        this.toSignal(
          instance,
          { ...verdict, side: "HOLD", reason },
          context,
          ts,
          { symbol: instance.symbol, price: context.candle.close },
        ),
      );
      this.deps.onError(new Error("derivative contract unavailable"), {
        where: "resolveTrade",
        strategyId: instance.strategyId,
        symbol: instance.symbol,
      });
      return;
    }

    const signal = this.toSignal(instance, verdict, context, ts, trade);
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

  /**
   * Which symbol and at what price this verdict actually trades.
   *
   * For an ordinary strategy: the analysed symbol at its own close. For a
   * derivative strategy the two come apart — the decision was made on the
   * index, the order goes on a contract, and it is the CONTRACT's price that
   * everything downstream must use. Sizing divides a risk budget by price, so
   * handing risk the index level (25,000) for a trade whose unit costs the
   * premium (150) would misprice the position by two orders of magnitude.
   *
   * Returns null when the contract cannot be resolved or priced — the caller
   * records the decision and declines to forward it. Never falls back to the
   * underlying: an index has no tradable contract, so "trade the thing I
   * analysed" is not a safe default here, it is a guaranteed rejection.
   */
  private resolveTrade(
    instance: Instance,
    verdict: StrategyVerdict,
    context: MarketContext,
    ts: number,
  ): { symbol: string; price: number; underlying?: string } | null {
    const target = instance.strategy.derivative();
    const spot = context.candle.close;
    if (target === null || verdict.side === "HOLD") {
      return { symbol: instance.symbol, price: spot };
    }
    const contract = this.deps.ports.resolveContract(
      target,
      verdict.side,
      spot,
      ts,
    );
    if (contract === null) return null;
    const price = this.deps.ports.readPrice(contract.symbol);
    // No price means the contract is resolved but not yet streaming. Refusing
    // is the same rule the Paper Broker applies (plan/11 §9): never invent a
    // fill price, and never size against one either.
    if (price === null || price <= 0) return null;
    return { symbol: contract.symbol, price, underlying: instance.symbol };
  }

  private toSignal(
    instance: Instance,
    verdict: StrategyVerdict,
    context: MarketContext,
    ts: number,
    trade: { symbol: string; price: number; underlying?: string },
  ): Signal {
    // Percentage stops resolve against the price actually being traded
    // (plan/15 §2): the strategy names a fraction because it could not know
    // the premium; this is the first point at which it is known.
    const stopLoss =
      verdict.stopLoss ??
      (verdict.stopLossPct === undefined
        ? undefined
        : trade.price * (1 - verdict.stopLossPct));
    const target =
      verdict.target ??
      (verdict.targetPct === undefined
        ? undefined
        : trade.price * (1 + verdict.targetPct));
    return {
      signalId: this.deps.nextSignalId(),
      strategyId: instance.strategyId,
      symbol: trade.symbol,
      ...(trade.underlying === undefined
        ? {}
        : { underlyingSymbol: trade.underlying }),
      side: verdict.side,
      confidence: verdict.confidence,
      ...(verdict.qtyProposal === undefined
        ? {}
        : { qtyProposal: verdict.qtyProposal }),
      ...(stopLoss === undefined ? {} : { stopLoss }),
      ...(target === undefined ? {} : { target }),
      reason: verdict.reason,
      contextSnapshot: {
        price: trade.price,
        indicators: context.indicators,
        session: context.session.phase,
        sentiment: context.sentiment,
      },
      ts,
    };
  }
}
