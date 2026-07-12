import type {
  Candle,
  CandleInterval,
  Order,
  Position,
  RiskLimits,
  SessionContext,
  SessionPhase,
  Signal,
  StrategyConfig,
} from "@neelkanth/core";
import type { EventName, EventPayload } from "@neelkanth/contracts";
import { PaperBroker } from "@neelkanth/broker";
import {
  computePortfolio,
  IndicatorEngine,
  OrderManager,
  PnlEngine,
  PositionEngine,
  registerIndicatorSpec,
  RiskEngine,
  StrategyRunner,
  type IndicatorPorts,
  type OrderPorts,
  type PnlPorts,
  type PositionPorts,
  type RiskPorts,
  type StrategyPorts,
} from "@neelkanth/engines";
import { createStrategyRegistry } from "@neelkanth/strategies";

/**
 * The golden-run pipeline harness (plan/27 §4): the whole machine wired with
 * in-memory ports so a recorded day of candles runs end-to-end with zero
 * infrastructure. It is the determinism proof — the same fixture always
 * produces the same signals, risk decisions, orders, fills, positions, and PnL
 * (plan/02 Principle 1) — and a preview of the real composition root (plan/05
 * §3): same engines, same injected dependencies, fake ports instead of Redis/
 * Mongo. Everything is deterministic: counter-based ids, the candle timestamp
 * as the clock, fixed slippage/charges, no randomness.
 */

export interface GoldenFixture {
  symbol: string;
  interval: CandleInterval;
  /** IST session-open epoch ms; drives minutesSinceOpen. */
  sessionOpenTs: number;
  candles: Candle[];
  strategies: StrategyConfig[];
  allocatedCapital: number;
  limits: RiskLimits;
}

interface SignalRow {
  signalId: string;
  strategyId: string;
  symbol: string;
  side: string;
  confidence: number;
  reason: string;
}
interface RiskDecisionRow {
  signalId: string;
  decision: string;
  failedCheck?: string;
  cappedQty?: number;
}
interface OrderRow {
  orderId: string;
  signalId: string;
  side: string;
  qty: number;
  status: string;
  filledPrice?: number;
  charges?: number;
}
interface PositionRow {
  strategyId: string;
  symbol: string;
  side: string;
  qty: number;
  avgEntryPrice: number;
  realizedPnl: number;
  status: string;
}

export interface GoldenRecord {
  signals: SignalRow[];
  riskDecisions: RiskDecisionRow[];
  orders: OrderRow[];
  positions: PositionRow[];
  realizedPnl: number;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export async function runGoldenPipeline(
  fixture: GoldenFixture,
): Promise<GoldenRecord> {
  const pipeline = new GoldenPipeline(fixture);
  return pipeline.run();
}

class GoldenPipeline {
  private readonly fixture: GoldenFixture;
  private now: number;
  private minutesSinceOpen = 0;
  private readonly hotPrice = new Map<string, number>();
  private readonly candleWindow = new Map<string, Candle[]>();
  private readonly ordersById = new Map<string, Order>();
  private readonly ordersBySignal = new Set<string>();
  private readonly positionsById = new Map<string, Position>();

  private readonly signals: SignalRow[] = [];
  private readonly riskDecisions: RiskDecisionRow[] = [];
  private readonly positionUpdates: PositionRow[] = [];

  private idSeq = 0;

  private readonly indicatorEngine: IndicatorEngine;
  private readonly runner: StrategyRunner;
  private readonly risk: RiskEngine;
  private readonly orderManager: OrderManager;
  private readonly positionEngine: PositionEngine;
  private readonly pnl: PnlEngine;

  constructor(fixture: GoldenFixture) {
    this.fixture = fixture;
    this.now = fixture.sessionOpenTs;

    const onError = (error: unknown): never => {
      // In a golden run any engine error is a bug in the machine, not a
      // tolerable degradation — fail the run loudly.
      throw error instanceof Error ? error : new Error(String(error));
    };
    const publish = this.publish.bind(this);

    // --- Position + PnL (projection chain) ---
    const positionPorts: PositionPorts = {
      writePosition: (position) => {
        this.positionsById.set(position.positionId, position);
        return Promise.resolve();
      },
      publish,
    };
    this.positionEngine = new PositionEngine({
      ports: positionPorts,
      nextPositionId: () => this.nextId("pos"),
      now: () => this.now,
      onError,
    });

    const pnlPorts: PnlPorts = {
      readPrice: (symbol) => Promise.resolve(this.hotPrice.get(symbol) ?? null),
      writeSnapshot: () => Promise.resolve(),
      publish,
    };
    this.pnl = new PnlEngine({
      ports: pnlPorts,
      getOpenPositions: () => this.positionEngine.getOpenPositions(),
      getRealized: () => ({
        global: this.positionEngine.realizedPnl(),
        byStrategy: new Map(),
      }),
      getTradeCount: () => this.positionEngine.getTradeCount(),
      now: () => this.now,
      onError,
    });

    // --- Order Manager + Paper Broker ---
    const broker = new PaperBroker({
      readPrice: (symbol) => Promise.resolve(this.hotPrice.get(symbol) ?? null),
      readSessionOpen: () => Promise.resolve(true),
      slippage: { kind: "percent", pct: 0.0005 },
      now: () => this.now,
    });
    const orderPorts: OrderPorts = {
      readTradingEnabled: () => Promise.resolve(true),
      persistOrder: (order) => {
        if (this.ordersBySignal.has(order.signalId)) {
          return Promise.resolve(false); // unique signalId backstop
        }
        this.ordersBySignal.add(order.signalId);
        this.ordersById.set(order.orderId, order);
        return Promise.resolve(true);
      },
      updateOrder: (orderId, patch) => {
        const existing = this.ordersById.get(orderId);
        if (existing) this.ordersById.set(orderId, { ...existing, ...patch });
        return Promise.resolve();
      },
      publish,
    };
    this.orderManager = new OrderManager({
      broker,
      ports: orderPorts,
      nextOrderId: () => this.nextId("ord"),
      now: () => this.now,
      onError,
    });

    // --- Risk Engine ---
    const riskPorts: RiskPorts = {
      readSession: () => Promise.resolve<SessionPhase>("open"),
      readDailyRealizedLoss: () =>
        Promise.resolve(Math.max(0, -this.positionEngine.realizedPnl())),
      readOpenPositionCount: () =>
        Promise.resolve(this.positionEngine.getOpenPositions().length),
      readPosition: (strategyId, symbol) =>
        Promise.resolve(this.positionEngine.getPosition(strategyId, symbol)),
      hasInflightIntent: (strategyId, symbol, side) => {
        const p = this.positionEngine.getPosition(strategyId, symbol);
        if (p === null) return Promise.resolve(false);
        // Reject stacking the same direction; exits (opposite) pass.
        return Promise.resolve(
          (side === "BUY" && p.side === "LONG") ||
            (side === "SELL" && p.side === "SHORT"),
        );
      },
      readPortfolio: () => {
        const p = computePortfolio(
          this.positionEngine.getOpenPositions(),
          (s) => this.hotPrice.get(s) ?? null,
          this.fixture.allocatedCapital,
          this.positionEngine.realizedPnl(),
        );
        return Promise.resolve({
          allocatedCapital: p.allocatedCapital,
          investedValue: p.investedValue,
          availableCapital: p.availableCapital,
        });
      },
      readGlobalLimits: () => Promise.resolve(this.fixture.limits),
      readStrategyOverride: () => Promise.resolve(null),
      persistRiskLog: (log) => {
        this.riskDecisions.push({
          signalId: log.signalId,
          decision: log.decision,
          ...(log.failedCheck === undefined
            ? {}
            : { failedCheck: log.failedCheck }),
          ...(log.cappedQty === undefined ? {} : { cappedQty: log.cappedQty }),
        });
        return Promise.resolve();
      },
      publish,
    };
    this.risk = new RiskEngine({ ports: riskPorts, onError });

    // --- Indicator Engine ---
    const indicatorPorts: IndicatorPorts = {
      writeHotIndicators: () => Promise.resolve(),
      loadWarmupCandles: () => Promise.resolve([]), // warms from live fixture bars
      publish,
    };
    this.indicatorEngine = new IndicatorEngine({
      ports: indicatorPorts,
      onError,
    });

    // --- Strategy Runner ---
    const strategyPorts: StrategyPorts = {
      readSession: () => Promise.resolve<SessionContext>(this.session()),
      readCandleWindow: (symbol, interval, count) =>
        Promise.resolve(
          (this.candleWindow.get(`${symbol}|${interval}`) ?? []).slice(-count),
        ),
      readPosition: (strategyId, symbol) =>
        Promise.resolve(this.positionEngine.getPosition(strategyId, symbol)),
      readSentiment: () => Promise.resolve(0),
      persistSignal: (signal) => {
        this.signals.push({
          signalId: signal.signalId,
          strategyId: signal.strategyId,
          symbol: signal.symbol,
          side: signal.side,
          confidence: round4(signal.confidence),
          reason: signal.reason,
        });
        return Promise.resolve();
      },
      publish,
    };
    this.runner = new StrategyRunner({
      registry: createStrategyRegistry(),
      ports: strategyPorts,
      provisionIndicators: (symbol, interval, specs) => {
        for (const spec of specs) {
          registerIndicatorSpec(this.indicatorEngine, symbol, interval, spec);
        }
        return this.indicatorEngine.warmUp(symbol, interval);
      },
      handoff: (signal) => this.handoff(signal),
      nextSignalId: () => this.nextId("sig"),
      onError,
    });
  }

  async run(): Promise<GoldenRecord> {
    for (const config of this.fixture.strategies) {
      await this.runner.enable(config);
    }
    for (const candle of this.fixture.candles) {
      await this.feedCandle(candle);
    }
    return {
      signals: this.signals,
      riskDecisions: this.riskDecisions,
      orders: [...this.ordersById.values()].map((o) => ({
        orderId: o.orderId,
        signalId: o.signalId,
        side: o.side,
        qty: o.qty,
        status: o.status,
        ...(o.filledPrice === undefined
          ? {}
          : { filledPrice: round4(o.filledPrice) }),
        ...(o.charges === undefined ? {} : { charges: round4(o.charges) }),
      })),
      positions: [...this.positionsById.values()].map((p) => ({
        strategyId: p.strategyId,
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        avgEntryPrice: round4(p.avgEntryPrice),
        realizedPnl: round4(p.realizedPnl),
        status: p.status,
      })),
      realizedPnl: round4(this.positionEngine.realizedPnl()),
    };
  }

  private async feedCandle(candle: Candle): Promise<void> {
    this.now = candle.ts;
    this.minutesSinceOpen = Math.round(
      (candle.ts - this.fixture.sessionOpenTs) / 60_000,
    );
    this.hotPrice.set(candle.symbol, candle.close);
    const key = `${candle.symbol}|${candle.interval}`;
    const window = this.candleWindow.get(key) ?? [];
    window.push(candle);
    this.candleWindow.set(key, window);

    this.runner.onCandleClosed(candle); // cache the bar for the indicator update
    await this.indicatorEngine.onCandleClosed(candle); // → INDICATORS_UPDATED → runner
  }

  /** The synchronous risk→order handoff (plan/14 §2). */
  private async handoff(signal: Signal): Promise<void> {
    const decision = await this.risk.validate(signal);
    if (decision.decision === "approved") {
      await this.orderManager.place(signal, decision);
    }
  }

  /** The in-memory event bus: record, then route to the next consumer. */
  private async publish<N extends EventName>(
    name: N,
    payload: EventPayload<N>,
  ): Promise<void> {
    if (name === "INDICATORS_UPDATED") {
      await this.runner.onIndicatorsUpdated(
        payload as EventPayload<"INDICATORS_UPDATED">,
      );
      return;
    }
    if (name === "ORDER_FILLED") {
      await this.positionEngine.onOrderFilled(
        payload as EventPayload<"ORDER_FILLED">,
      );
      return;
    }
    if (name === "POSITION_UPDATED") {
      const p = payload as EventPayload<"POSITION_UPDATED">;
      this.positionUpdates.push({
        strategyId: p.strategyId,
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        avgEntryPrice: round4(p.avgEntryPrice),
        realizedPnl: round4(p.realizedPnl),
        status: p.status,
      });
      await this.pnl.refresh(); // realized changed (plan/13 §5)
      return;
    }
    // SIGNAL_CREATED / RISK_BLOCKED / ORDER_PLACED / PNL_UPDATED: captured via
    // the durable-write ports; nothing to route.
  }

  private session(): SessionContext {
    return { phase: "open", minutesSinceOpen: this.minutesSinceOpen };
  }

  private nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}_${String(this.idSeq)}`;
  }
}
