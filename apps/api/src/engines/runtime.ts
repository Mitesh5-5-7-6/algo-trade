import type {
  Candle,
  RiskLimits,
  RiskRules,
  SessionContext,
  SessionPhase,
  Signal,
} from "@neelkanth/core";
import type { EventName, EventPayload } from "@neelkanth/contracts";
import { componentLogger, type Logger } from "@neelkanth/logger";
import {
  createEventBus,
  hotIndicatorsKey,
  hotPriceKey,
  hotSessionKey,
  type EventBus,
  type RedisConnections,
} from "@neelkanth/redis";
import {
  CandlesRepository,
  OrdersRepository,
  PnlSnapshotsRepository,
  PositionsRepository,
  RiskLogsRepository,
  SettingsRepository,
  SignalsRepository,
  StrategiesRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { PaperBroker } from "@neelkanth/broker";
import {
  computePortfolio,
  IndicatorEngine,
  istDateKey,
  OrderManager,
  PnlEngine,
  PositionEngine,
  registerIndicatorSpec,
  RiskEngine,
  SessionManager,
  StrategyRunner,
  type IndicatorPorts,
  type OrderPorts,
  type PnlPorts,
  type PositionPorts,
  type RiskPorts,
  type StrategyPorts,
} from "@neelkanth/engines";
import { createStrategyRegistry } from "@neelkanth/strategies";

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const CANDLE_WINDOW = 60;

function parseHHMM(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}
function istMinuteOfDay(now: number): number {
  const ist = new Date(now + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export interface EngineRuntime {
  readonly bus: EventBus;
  readonly positionEngine: PositionEngine;
  /** Reflect a control-plane pause/kill/resume into the hot kill gate. */
  setTradingEnabled(enabled: boolean): void;
  /** Evaluate the session at `now` and drive its side effects (plan/17 §6). */
  syncSession(now: number): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Construct and wire every engine with real Redis + Mongo dependencies — the
 * production form of the golden-run harness (plan/05 §3, plan/27 §4). The
 * risk→order path is a direct in-process call (Regime A, plan/14 §2); the
 * fill→position→PnL projection flows over the Redis event bus (Regime B,
 * plan/02 §6). The data plane (Market Data Engine + FYERS feed, plan/17/19)
 * attaches to the same bus once broker credentials exist; until then the
 * pipeline is wired and idle.
 */
export async function startEngineRuntime(deps: {
  redis: RedisConnections;
  mongo: MongoConnection;
  logger: Logger;
}): Promise<EngineRuntime> {
  const { redis, logger } = deps;
  const db = deps.mongo.db;
  const log = componentLogger(logger, "api.runtime");
  const onError = (error: unknown, context: Record<string, unknown>): void => {
    log.error({ err: error, ...context }, "engine error");
  };

  // --- Repositories + bus ---
  const orders = new OrdersRepository(db);
  const positions = new PositionsRepository(db);
  const signals = new SignalsRepository(db);
  const riskLogs = new RiskLogsRepository(db);
  const pnlSnapshots = new PnlSnapshotsRepository(db);
  const candles = new CandlesRepository(db);
  const strategiesRepo = new StrategiesRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const bus = createEventBus(redis.publisher, redis.subscriber, onError);
  // A local wrapper so ports pass a plain function (not an unbound method).
  function publish<N extends EventName>(
    name: N,
    payload: EventPayload<N>,
    correlationId?: string,
  ): Promise<void> {
    return bus.publish(name, payload, correlationId);
  }

  // --- In-memory runtime state (single process; the fast read path) ---
  const lastPrices = new Map<string, number>();
  const candleWindows = new Map<string, Candle[]>();
  const enabledConfigs = new Map<string, { riskRules?: RiskRules }>();
  const settings = await settingsRepo.getGlobal();
  const state = {
    tradingEnabled: settings.tradingEnabled,
    limits: settings.globalRiskLimits satisfies RiskLimits,
    allocatedCapital: settings.capitalAllocation,
    session: { phase: "closed", minutesSinceOpen: -1 } as SessionContext,
  };
  const openMinute = parseHHMM(settings.marketHours.open);
  const sessionManager = new SessionManager({
    preOpen: "09:00",
    open: settings.marketHours.open,
    close: settings.marketHours.close,
    holidays: [],
    exchange: "NSE",
  });

  // --- Hot-state writes (Redis; the cross-process / dashboard copy) ---
  const writeHot = (key: string, value: unknown): Promise<unknown> =>
    redis.client.set(key, JSON.stringify(value));

  // --- Projection chain: Position + PnL ---
  const positionPorts: PositionPorts = {
    writePosition: (position) => positions.upsert(position),
    publish,
  };
  const positionEngine = new PositionEngine({
    ports: positionPorts,
    nextPositionId: () => `pos_${crypto.randomUUID()}`,
    onError,
  });

  const pnlPorts: PnlPorts = {
    readPrice: (symbol) => Promise.resolve(lastPrices.get(symbol) ?? null),
    writeSnapshot: (snapshot) => pnlSnapshots.upsert(snapshot),
    publish,
  };
  const pnl = new PnlEngine({
    ports: pnlPorts,
    getOpenPositions: () => positionEngine.getOpenPositions(),
    getRealized: () => ({
      global: positionEngine.realizedPnl(),
      byStrategy: new Map(),
    }),
    getTradeCount: () => positionEngine.getTradeCount(),
    onError,
  });

  // --- Execution: Paper Broker + Order Manager ---
  const broker = new PaperBroker({
    readPrice: (symbol) => Promise.resolve(lastPrices.get(symbol) ?? null),
    readSessionOpen: () => Promise.resolve(state.session.phase === "open"),
  });
  const orderPorts: OrderPorts = {
    readTradingEnabled: () => Promise.resolve(state.tradingEnabled),
    persistOrder: (order) => orders.insert(order),
    updateOrder: (orderId, patch) => orders.update(orderId, patch),
    publish,
  };
  const orderManager = new OrderManager({
    broker,
    ports: orderPorts,
    nextOrderId: () => `ord_${crypto.randomUUID()}`,
    onError,
  });

  // --- Risk Engine ---
  const riskPorts: RiskPorts = {
    readSession: () => Promise.resolve<SessionPhase>(state.session.phase),
    readDailyRealizedLoss: () =>
      Promise.resolve(Math.max(0, -positionEngine.realizedPnl())),
    readOpenPositionCount: () =>
      Promise.resolve(positionEngine.getOpenPositions().length),
    readPosition: (strategyId, symbol) =>
      Promise.resolve(positionEngine.getPosition(strategyId, symbol)),
    hasInflightIntent: (strategyId, symbol, side) => {
      const p = positionEngine.getPosition(strategyId, symbol);
      if (p === null) return Promise.resolve(false);
      return Promise.resolve(
        (side === "BUY" && p.side === "LONG") ||
          (side === "SELL" && p.side === "SHORT"),
      );
    },
    readPortfolio: () => {
      const p = computePortfolio(
        positionEngine.getOpenPositions(),
        (s) => lastPrices.get(s) ?? null,
        state.allocatedCapital,
        positionEngine.realizedPnl(),
      );
      return Promise.resolve({
        allocatedCapital: p.allocatedCapital,
        investedValue: p.investedValue,
        availableCapital: p.availableCapital,
      });
    },
    readGlobalLimits: () => Promise.resolve(state.limits),
    readStrategyOverride: (strategyId) =>
      Promise.resolve(enabledConfigs.get(strategyId)?.riskRules ?? null),
    persistRiskLog: (logEntry) => riskLogs.insert(logEntry),
    publish,
  };
  const risk = new RiskEngine({ ports: riskPorts, onError });

  // --- Indicator Engine ---
  const indicatorPorts: IndicatorPorts = {
    writeHotIndicators: (symbol, interval, snapshot) =>
      writeHot(hotIndicatorsKey(symbol), { interval, ...snapshot }).then(
        () => undefined,
      ),
    loadWarmupCandles: (symbol, interval, limit) =>
      candles.loadRecent(symbol, interval, limit),
    publish,
  };
  const indicatorEngine = new IndicatorEngine({
    ports: indicatorPorts,
    onError,
  });

  // --- Strategy Runner ---
  const strategyPorts: StrategyPorts = {
    readSession: () => Promise.resolve(state.session),
    readCandleWindow: (symbol, interval, count) =>
      Promise.resolve(
        (candleWindows.get(`${symbol}|${interval}`) ?? []).slice(-count),
      ),
    readPosition: (strategyId, symbol) =>
      Promise.resolve(positionEngine.getPosition(strategyId, symbol)),
    readSentiment: () => Promise.resolve(0),
    persistSignal: (signal) => signals.insert(signal),
    publish,
  };
  const handoff = async (signal: Signal): Promise<void> => {
    const decision = await risk.validate(signal); // synchronous critical path
    if (decision.decision === "approved") {
      await orderManager.place(signal, decision);
    }
  };
  const runner = new StrategyRunner({
    registry: createStrategyRegistry(),
    ports: strategyPorts,
    provisionIndicators: async (symbol, interval, specs) => {
      for (const spec of specs) {
        registerIndicatorSpec(indicatorEngine, symbol, interval, spec);
      }
      await indicatorEngine.warmUp(symbol, interval);
    },
    handoff,
    nextSignalId: () => `sig_${crypto.randomUUID()}`,
    onError,
  });

  // --- Bus wiring ---
  const appendWindow = (candle: Candle): void => {
    const key = `${candle.symbol}|${candle.interval}`;
    const window = candleWindows.get(key) ?? [];
    window.push(candle);
    if (window.length > CANDLE_WINDOW) window.shift();
    candleWindows.set(key, window);
  };
  await bus.subscribe("MARKET_TICK", (event) => {
    lastPrices.set(event.payload.symbol, event.payload.ltp);
  });
  await bus.subscribe("CANDLE_CLOSED", async (event) => {
    const candle = event.payload;
    lastPrices.set(candle.symbol, candle.close);
    appendWindow(candle);
    runner.onCandleClosed(candle); // cache the bar for the indicator update
    await indicatorEngine.onCandleClosed(candle); // → INDICATORS_UPDATED
  });
  await bus.subscribe("INDICATORS_UPDATED", (event) =>
    runner.onIndicatorsUpdated(event.payload),
  );
  await bus.subscribe("ORDER_FILLED", (event) =>
    positionEngine.onOrderFilled(event.payload),
  );
  await bus.subscribe("POSITION_UPDATED", () => pnl.refresh());

  // --- Boot sequence (plan/05 §3, plan/22 §4) ---
  // Hydrate open positions, reconcile stuck orders, then enable strategies
  // (which registers + warms their indicators). The kill flag was honored by
  // the composition root before this point.
  positionEngine.hydrate(await positions.findOpen());
  for (const order of await orders.findByStatus(["PLACED", "PENDING"])) {
    await orderManager.reconcile(order);
  }
  for (const config of await strategiesRepo.findEnabled()) {
    enabledConfigs.set(
      config.strategyId,
      config.riskRules === undefined ? {} : { riskRules: config.riskRules },
    );
    await runner.enable(config);
  }
  log.info(
    { openPositions: positionEngine.getOpenPositions().length },
    "engine runtime wired",
  );

  return {
    bus,
    positionEngine,
    setTradingEnabled(enabled) {
      state.tradingEnabled = enabled;
    },
    async syncSession(now) {
      const evaluation = sessionManager.evaluate(now);
      state.session = {
        phase: evaluation.phase,
        minutesSinceOpen: istMinuteOfDay(now) - openMinute,
      };
      if (evaluation.phaseChanged) {
        await writeHot(hotSessionKey(), evaluation.phase);
      }
      if (evaluation.marketOpened) {
        indicatorEngine.onMarketOpen();
        positionEngine.resetDaily();
        await bus.publish("MARKET_OPEN", {
          exchange: "NSE",
          session: istDateKey(now),
          ts: now,
        });
      }
      if (evaluation.marketClosed) {
        await bus.publish("MARKET_CLOSE", {
          exchange: "NSE",
          session: istDateKey(now),
          ts: now,
        });
        await pnl.snapshot(istDateKey(now)); // EOD equity curve (plan/13 §6)
      }
    },
    async shutdown() {
      await bus.close();
    },
  };
}

/** Expose the hot price key for tests/inspection. */
export { hotPriceKey };
