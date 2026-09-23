import type {
  CandleInterval,
  DerivativeTarget,
  MarketContext,
  Signal,
  StrategyConfig,
  StrategyVerdict,
} from "@neelkanth/core";
import { indicatorKey } from "@neelkanth/indicators";
import type {
  RunnableStrategy,
  SignalResolution,
  StrategyRegistry,
} from "@neelkanth/strategies";
import type { EventPayload } from "@neelkanth/contracts";
import { buildContext } from "./context-builder.js";
import type {
  IndicatorProvisioner,
  RiskHandoff,
  StoredStrategyState,
  StrategyPorts,
} from "./ports.js";

/**
 * A forwarded signal awaiting its verdict.
 *
 * The side is carried here rather than looked up later, because none of the
 * events that decide a signal's fate carry it back: `RISK_BLOCKED` names the
 * check that failed, `ORDER_FILLED` names the order. The strategy needs to
 * know WHICH of its proposals this was.
 */
interface PendingSignal {
  readonly instanceKey: string;
  readonly side: "BUY" | "SELL";
}

/** A live per-(strategy, symbol) instance; state is private to the strategy. */
interface Instance {
  readonly strategyId: string;
  readonly symbol: string;
  readonly interval: CandleInterval;
  readonly strategy: RunnableStrategy;
  readonly type: string;
  errored: boolean;
  errorCount: number;
  /**
   * The snapshot as last written, so an unchanged state costs no write.
   *
   * Compared as a string rather than by identity: the strategy mutates its
   * state in place, so the object is always the same object and always looks
   * changed.
   */
  lastPersisted: string | null;
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
  /** Cap on signals awaiting a verdict, so a lost event cannot grow forever. */
  maxPendingSignals?: number;
  /** Clock for state timestamps; injected so a replay is reproducible. */
  now?: () => number;
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
  private readonly maxPendingSignals: number;
  private readonly now: () => number;
  /** `${strategyId}|${symbol}` → instance. */
  private readonly instances = new Map<string, Instance>();
  /** Latest closed candle per `${symbol}|${interval}` (matched by ts). */
  private readonly latestCandle = new Map<
    string,
    EventPayload<"CANDLE_CLOSED">
  >();
  /**
   * signalId → the instance that emitted it, for signals awaiting a verdict.
   *
   * ORDER_FILLED does not carry a signalId — only an orderId — so the chain is
   * two hops: ORDER_PLACED links the two, and the fill is looked up through
   * it. Both maps are erased the moment a signal resolves.
   */
  private readonly pendingSignals = new Map<string, PendingSignal>();
  private readonly orderToSignal = new Map<string, string>();

  constructor(deps: StrategyRunnerDeps) {
    this.deps = deps;
    this.minConfidence = deps.minConfidence ?? 0;
    this.candleWindow = deps.candleWindow ?? 50;
    this.maxErrors = deps.maxErrors ?? 5;
    this.maxPendingSignals = deps.maxPendingSignals ?? 500;
    this.now = deps.now ?? (() => Date.now());
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
      const instance: Instance = {
        strategyId: config.strategyId,
        symbol,
        interval: strategy.interval,
        strategy,
        type: config.type,
        errored: false,
        errorCount: 0,
        lastPersisted: null,
      };
      this.instances.set(`${config.strategyId}|${symbol}`, instance);
      await this.hydrateState(instance);
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
    // Forget anything it had in flight. The orders themselves are unaffected —
    // this only stops a later fill being routed to an instance that is gone.
    for (const [signalId, pending] of this.pendingSignals) {
      if (pending.instanceKey.startsWith(`${strategyId}|`)) {
        this.pendingSignals.delete(signalId);
      }
    }
  }

  /**
   * Restore a freshly created instance's state from storage (§0.5.6).
   *
   * Refuses more than it accepts, and says which. A snapshot is an opaque blob
   * whose meaning lives entirely in the code that wrote it, so reading one
   * back into a different strategy — or into a later build whose fields mean
   * something else — produces a running strategy with plausible state and no
   * error anywhere. Every refusal here leaves the instance cold, which is
   * exactly the behaviour that existed before any of this.
   */
  private async hydrateState(instance: Instance): Promise<void> {
    const ports = this.deps.ports;
    if (ports.loadStrategyState === undefined) return;
    const version = instance.strategy.stateVersion;
    if (version === null) return; // this strategy does not persist state

    try {
      const stored = await ports.loadStrategyState(
        instance.strategyId,
        instance.symbol,
      );
      if (stored === null) return;
      if (stored.type !== instance.type) {
        this.deps.onError(
          new Error("stored state belongs to another strategy"),
          {
            where: "hydrateState",
            strategyId: instance.strategyId,
            symbol: instance.symbol,
            stored: stored.type,
            expected: instance.type,
          },
        );
        return;
      }
      if (stored.stateVersion !== version) {
        // Not an error — a deploy changed the shape, and refusing the old
        // snapshot is the correct response rather than a fault to fix.
        this.deps.onError(new Error("stored state is a different version"), {
          where: "hydrateState",
          strategyId: instance.strategyId,
          symbol: instance.symbol,
          stored: stored.stateVersion,
          expected: version,
          note: "starting cold, which is what happened before state was persisted",
        });
        return;
      }
      if (!instance.strategy.restore(stored.snapshot)) return;
      instance.lastPersisted = JSON.stringify(stored.snapshot);
    } catch (error) {
      // A snapshot that will not parse must not stop the strategy running.
      this.deps.onError(error, {
        where: "hydrateState",
        strategyId: instance.strategyId,
        symbol: instance.symbol,
      });
    }
  }

  /**
   * Write this instance's state, if it changed (§0.5.6).
   *
   * Called after every decision and after every resolution, because both move
   * it — a latch is set by one and confirmed by the other. Never rejects: the
   * in-memory state is already correct, and a storage hiccup must not stop the
   * machine trading.
   */
  private async persistState(instance: Instance): Promise<void> {
    const ports = this.deps.ports;
    if (ports.saveStrategyState === undefined) return;
    const version = instance.strategy.stateVersion;
    if (version === null) return;

    try {
      const snapshot = instance.strategy.snapshot();
      if (snapshot === null) return;
      const serialized = JSON.stringify(snapshot);
      if (serialized === instance.lastPersisted) return;

      const record: StoredStrategyState = {
        strategyId: instance.strategyId,
        symbol: instance.symbol,
        type: instance.type,
        stateVersion: version,
        snapshot,
        updatedAt: this.now(),
      };
      await ports.saveStrategyState(record);
      instance.lastPersisted = serialized;
    } catch (error) {
      this.deps.onError(error, {
        where: "persistState",
        strategyId: instance.strategyId,
        symbol: instance.symbol,
      });
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
        const optionChain = instance.strategy.requiresOptionChain()
          ? await this.deps.ports.readOptionChain?.(
              instance.strategy.derivative()?.underlying ?? payload.symbol,
            )
          : undefined;
        const context = buildContext({
          symbol: payload.symbol,
          interval,
          candle,
          candles,
          indicators: payload.indicators,
          session,
          position,
          sentiment,
          ...(optionChain === undefined || optionChain === null
            ? {}
            : { optionChain }),
        });

        await this.runOne(instance, context, candle.ts);
        // The bar moved this instance's state, whatever it decided — a HOLD
        // still advances an opening range and the previous bar's EMAs.
        await this.persistState(instance);
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
    // it never proceeds to risk. A HOLD proposes nothing, so there is no latch
    // to release.
    if (verdict.side === "HOLD") return;

    // Below-threshold signals are recorded but not forwarded (plan/15 §6). The
    // strategy still has to hear about it: it marked an entry as proposed, and
    // a proposal nobody will ever act on must not sit there spending the day.
    if (verdict.confidence < this.minConfidence) {
      this.resolve(instance, {
        signalId: signal.signalId,
        side: verdict.side,
        status: "REJECTED",
        reason: "below the confidence threshold",
      });
      return;
    }

    this.remember(signal.signalId, instance, verdict.side);
    await this.deps.handoff(signal); // synchronous risk→order (plan/14 §2)
  }

  /**
   * Tell a strategy what became of a signal it emitted (§0.5.5).
   *
   * Never throws into the caller: these arrive on the order path, and a
   * strategy misbehaving in its callback must not disturb order handling.
   */
  private resolve(instance: Instance, resolution: SignalResolution): void {
    this.pendingSignals.delete(resolution.signalId);
    try {
      instance.strategy.onSignalOutcome(resolution);
      // A resolution moves the latch, and the latch is the part of the state
      // that most needs to survive: a restart that forgets an entry was
      // confirmed would take it again.
      void this.persistState(instance);
    } catch (error) {
      this.deps.onError(error, {
        where: "onSignalOutcome",
        strategyId: instance.strategyId,
        symbol: instance.symbol,
        signalId: resolution.signalId,
      });
    }
  }

  /** Track a forwarded signal until something decides its fate. */
  private remember(
    signalId: string,
    instance: Instance,
    side: "BUY" | "SELL",
  ): void {
    if (this.pendingSignals.size >= this.maxPendingSignals) {
      // Something upstream has stopped resolving. Drop the oldest and say so,
      // rather than growing a map for the life of the process.
      const oldest = this.pendingSignals.keys().next();
      if (!oldest.done) {
        this.pendingSignals.delete(oldest.value);
        this.deps.onError(new Error("pending signal evicted unresolved"), {
          where: "remember",
          signalId: oldest.value,
        });
      }
    }
    this.pendingSignals.set(signalId, {
      instanceKey: `${instance.strategyId}|${instance.symbol}`,
      side,
    });
  }

  private pendingFor(
    signalId: string,
  ): { instance: Instance; pending: PendingSignal } | null {
    const pending = this.pendingSignals.get(signalId);
    if (pending === undefined) return null;
    const instance = this.instances.get(pending.instanceKey);
    return instance === undefined ? null : { instance, pending };
  }

  /**
   * A signal the Risk Engine refused (§0.5.5).
   *
   * This is the case the whole mechanism exists for. Before it, a block at
   * 09:20 consumed ORB's single daily entry and the strategy stayed silent
   * until the close — indistinguishable, from the outside, from a day on which
   * no breakout ever happened.
   */
  onRiskBlocked(payload: EventPayload<"RISK_BLOCKED">): void {
    const found = this.pendingFor(payload.signalId);
    if (found === null) return;
    this.resolve(found.instance, {
      signalId: payload.signalId,
      side: found.pending.side,
      status: "REJECTED",
      reason: `risk blocked: ${payload.failedCheck}`,
    });
  }

  /**
   * An order reached the broker — remember which signal it came from.
   *
   * `ORDER_FILLED` carries an orderId and no signalId, so without this link
   * a fill cannot be attributed to the proposal it confirms.
   */
  onOrderPlaced(payload: EventPayload<"ORDER_PLACED">): void {
    if (!this.pendingSignals.has(payload.signalId)) return;
    this.orderToSignal.set(payload.orderId, payload.signalId);
  }

  /** The broker refused the order — the proposal is released. */
  onOrderRejected(payload: EventPayload<"ORDER_REJECTED">): void {
    this.orderToSignal.delete(payload.orderId);
    const found = this.pendingFor(payload.signalId);
    if (found === null) return;
    this.resolve(found.instance, {
      signalId: payload.signalId,
      side: found.pending.side,
      status: "REJECTED",
      reason: `broker rejected: ${payload.reason}`,
    });
  }

  /**
   * A confirmed execution — and the only thing that makes an entry real.
   *
   * Keyed on the order rather than the position, because the position is a
   * projection that can merge several fills; the question here is narrower:
   * did THIS proposal become a trade?
   */
  onOrderFilled(payload: EventPayload<"ORDER_FILLED">): void {
    const signalId = this.orderToSignal.get(payload.orderId);
    if (signalId === undefined) return;
    this.orderToSignal.delete(payload.orderId);
    const found = this.pendingFor(signalId);
    if (found === null) return;
    this.resolve(found.instance, {
      signalId,
      side: found.pending.side,
      status: "FILLED",
      reason: `filled ${String(payload.qty)} @ ${String(payload.filledPrice)}`,
    });
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
