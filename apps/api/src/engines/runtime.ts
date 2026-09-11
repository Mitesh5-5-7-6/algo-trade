import type {
  BrokerConnectionState,
  Candle,
  CandleInterval,
  TradeMode,
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
import type { Broker } from "@neelkanth/broker";
import { fyersNormalizer } from "./fyers-normalizer.js";
import {
  computePortfolio,
  EquityCurveTracker,
  ExitEngine,
  IndicatorEngine,
  istDateKey,
  MarketBiasEngine,
  MarketDataEngine,
  OrderManager,
  PnlEngine,
  PositionEngine,
  registerIndicatorSpec,
  RiskEngine,
  SessionManager,
  startOfDayIST,
  StrategyRunner,
  unrealizedPnl,
  type IndicatorPorts,
  type MarketDataPorts,
  type OrderPorts,
  type PnlPorts,
  type PositionPorts,
  type RiskPorts,
  type StrategyPorts,
} from "@neelkanth/engines";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { loadInstrumentMaster } from "./load-instruments.js";
import type { RuntimeControls } from "../control-plane/controls.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
/**
 * Bars kept per (symbol, interval). Sized to span a full NSE session at 5m
 * (09:15–15:30 is 75 bars): a strategy that anchors on the session — ORB reads
 * its opening range out of this window — must still be able to see the open
 * from a cold start late in the day.
 */
const CANDLE_WINDOW = 90;

/** The intervals the aggregator builds, and therefore the ones we can seed. */
const MARKET_INTERVALS = ["1m", "5m"] as const satisfies readonly CandleInterval[];

function parseHHMM(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}
function istMinuteOfDay(now: number): number {
  const ist = new Date(now + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
/** Epoch ms of the given IST minute-of-day on `now`'s trading date. */
function istMinuteTs(now: number, minuteOfDay: number): number {
  return startOfDayIST(now) + minuteOfDay * 60_000;
}

/**
 * The market-data working set: every symbol any enabled strategy needs, once
 * (plan/17 §7).
 *
 * Deduplicated because two strategies on the same instrument must produce one
 * subscription, not two — the broker counts subscriptions against a quota, and
 * a duplicated symbol would also duplicate every tick downstream.
 *
 * Extracted so the derivation is testable on its own. The wiring that calls it
 * is what was missing before: the engine's `subscribe` existed and was tested,
 * but nothing in the runtime ever invoked it.
 */
export function deriveWorkingSet(
  enabled: Iterable<{ symbols: readonly string[] }>,
): string[] {
  return [...new Set([...enabled].flatMap((config) => config.symbols))];
}

export interface EngineRuntime extends RuntimeControls {
  readonly bus: EventBus;
  readonly positionEngine: PositionEngine;
  /** Evaluate the session at `now` and drive its side effects (plan/17 §6). */
  syncSession(now: number): Promise<void>;
  /** Record an intraday equity sample at `now` (plan/06 §4 day curve). */
  sampleEquity(now: number): void;
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
  broker: Broker;
  /** Stamped on every order and fill event — the audit trail (plan/12 §4). */
  mode: TradeMode;
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
  // Symbols ride along with the risk rules because the market-data working
  // set is derived from them: subscribing is not a side effect of enabling a
  // strategy, it IS how an enabled strategy receives anything at all.
  const enabledConfigs = new Map<
    string,
    { riskRules?: RiskRules; symbols: readonly string[] }
  >();
  const settings = await settingsRepo.getGlobal();
  const state = {
    tradingEnabled: settings.tradingEnabled,
    limits: settings.globalRiskLimits satisfies RiskLimits,
    allocatedCapital: settings.capitalAllocation,
    session: {
      phase: "closed",
      minutesSinceOpen: -1,
      sessionOpenTs: 0,
    } as SessionContext,
  };

  // Market-data feed state, tracked so the control plane can report it
  // (plan/19 §4). Starts `disconnected` and is only ever moved by the broker
  // itself — a feed that never connects must read as never connected, which is
  // exactly the case a missing FYERS token produces.
  const brokerState: { state: BrokerConnectionState; since?: number } = {
    state: "disconnected",
  };
  deps.broker.onConnectionChange((next) => {
    if (next === brokerState.state) return;
    const previous = brokerState.state;
    brokerState.state = next;
    brokerState.since = Date.now();
    log.info({ broker: next }, "broker connection state changed");

    // Announce it on the bus. BROKER_CONNECTED/BROKER_DISCONNECTED were in the
    // event catalog, subscribed by the realtime bridge, and handled by the
    // dashboard's event map — but NOTHING ever published them. So the status
    // strip could only ever show its initial guess: the feed could drop
    // mid-session and the operator's screen would go on claiming it was live.
    //
    // `connecting` is deliberately not announced: it is a transient the
    // operator cannot act on, and emitting it would make the strip flicker on
    // every reconnect the SDK performs on its own.
    if (next === "connected") {
      void publish("BROKER_CONNECTED", {
        broker: "fyers",
        mode: deps.mode,
        ts: brokerState.since,
      }).catch((error: unknown) => {
        onError(error, { at: "publish BROKER_CONNECTED" });
      });
    } else if (next === "disconnected" && previous === "connected") {
      void publish("BROKER_DISCONNECTED", {
        broker: "fyers",
        mode: deps.mode,
        // The adapter reports the transition, not a cause; say that plainly
        // rather than inventing a reason the schema demands but we lack.
        reason: "broker reported the connection closed",
        ts: brokerState.since,
      }).catch((error: unknown) => {
        onError(error, { at: "publish BROKER_DISCONNECTED" });
      });
    }
  });

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

  // --- Market Data Engine (Inbound) ---
  const marketDataPorts: MarketDataPorts = {
    writeHotPrice: (symbol, tick) =>
      writeHot(hotPriceKey(symbol), tick).then(() => undefined),
    writeHotSession: (phase) =>
      writeHot(hotSessionKey(), { phase }).then(() => undefined),
    saveCandle: (candle) => candles.upsert(candle),
    publish,
  };
  const marketDataEngine = new MarketDataEngine({
    ports: marketDataPorts,
    normalizer: fyersNormalizer,
    intervals: MARKET_INTERVALS,
    session: sessionManager,
    exchange: "NSE",
    onError,
  });
  marketDataEngine.attach(deps.broker);

  /**
   * Point the feed at the union of the enabled strategies' symbols (plan/17 §7).
   *
   * This is the link between "a strategy is enabled" and "its instrument
   * actually streams". It was missing: `MarketDataEngine.subscribe()` was never
   * called from anywhere, so the working set stayed empty, the guard inside it
   * skipped `feed.subscribe()`, and FYERS was asked for nothing. The socket
   * connected — the Broker chip even read FEED LIVE, truthfully — while zero
   * ticks arrived. No ticks, no candles, no indicators, no signals, no orders.
   *
   * Called after every change to the enabled set, and the engine re-applies it
   * on reconnect since subscriptions do not survive one.
   */
  const syncWorkingSet = async (): Promise<void> => {
    const traded = deriveWorkingSet(enabledConfigs.values());
    // Indices ride along for DATA only (plan/17 §7). They are never traded —
    // an index has no tradable contract — but the market-bias gate cannot read
    // direction from instruments it does not receive.
    const symbols = [...new Set([...traded, ...settings.indexSymbols])];
    await marketDataEngine.subscribe(symbols);
    log.info(
      { symbols, traded: traded.length, indices: settings.indexSymbols.length },
      "market data working set",
    );
  };

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

  // --- Execution: Broker + Order Manager ---
  const orderPorts: OrderPorts = {
    readTradingEnabled: () => Promise.resolve(state.tradingEnabled),
    persistOrder: (order) => orders.insert(order),
    updateOrder: (orderId, patch) => orders.update(orderId, patch),
    readOrder: (orderId) => orders.findByOrderId(orderId),
    publish,
  };
  const orderManager = new OrderManager({
    broker: deps.broker,
    ports: orderPorts,
    // From BROKER_MODE, not from which broker object was wired: the paper
    // path can be given a LIVE data feed, so the object identity does not
    // answer "is this real money?".
    mode: deps.mode,
    nextOrderId: () => `ord_${crypto.randomUUID()}`,
    onError,
  });

  // The plan/12 §7 halt. It existed only as an untouched setter: nothing in
  // production ever called it, so the Order Manager's `brokerConnected` sat at
  // its `true` default forever and orders could be fired at a broker we had
  // already lost contact with.
  //
  // LIVE ONLY, for the same reason `mode` is injected rather than sniffed: in
  // paper mode this state describes the FYERS *data* feed while execution is
  // the in-process simulator, which cannot disconnect. Halting paper execution
  // on a feed blip would invent an outage that isn't there — and a paper order
  // with no price is already refused by the Paper Broker on its own terms.
  if (deps.mode === "live") {
    deps.broker.onConnectionChange((next) => {
      orderManager.setBrokerConnected(next === "connected");
    });
  }

  // The async half of a live submission (plan/19 §5). `execute()` returns
  // PENDING and the fill arrives here, later, on the broker's order stream.
  // Nothing consumed that stream before, so a live order never left PENDING:
  // no ORDER_FILLED, no position, no PnL, against money that had moved.
  deps.broker.onOrderUpdate((update) => {
    void orderManager.onBrokerUpdate(update);
  });

  // --- Symbol master: lot sizes for position sizing (plan/17 §7) ---
  const instruments = await loadInstrumentMaster(log);

  /**
   * The market view every entry is checked against (plan/14 §4).
   *
   * Indices supply direction, the traded universe supplies participation —
   * see `MarketView` for why neither alone is enough to block on.
   */
  const marketBias = new MarketBiasEngine({
    ports: {
      readCandleWindow: (symbol, interval, count) =>
        Promise.resolve(
          (candleWindows.get(`${symbol}|${interval}`) ?? []).slice(-count),
        ),
    },
    indexSymbols: () => settings.indexSymbols,
    breadthSymbols: () => deriveWorkingSet(enabledConfigs.values()),
    bars: CANDLE_WINDOW,
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
    // "in flight OR open" — the port contract (plan/14 §4.2). Only the OPEN
    // half was implemented, leaving the window this check exists to close:
    // an order is PLACED and submitted, the fill has not returned, so no
    // position exists yet — and a second signal arriving in that gap sees
    // nothing, passes, and doubles the entry. Ticks arrive milliseconds
    // apart, so that window is real.
    //
    // Position first because it is in memory and free; the order query only
    // runs when the cheap answer is no.
    hasInflightIntent: async (strategyId, symbol, side) => {
      const p = positionEngine.getPosition(strategyId, symbol);
      if (
        p !== null &&
        ((side === "BUY" && p.side === "LONG") ||
          (side === "SELL" && p.side === "SHORT"))
      ) {
        return true;
      }
      return await orders.hasInflightOrder(strategyId, symbol, side);
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
    readMarketView: () => marketBias.current(),
    readInstrument: (symbol) => instruments.get(symbol),
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
    candleWindow: CANDLE_WINDOW,
    onError,
  });

  // --- Exit Engine: stops, targets, and the intraday square-off ---
  const exitEngine = new ExitEngine({
    ports: {
      readOpenPositions: () => positionEngine.getOpenPositions(),
      readSession: () => Promise.resolve(state.session),
      persistSignal: (signal) => signals.insert(signal),
    },
    handoff, // the same risk→order road a strategy signal takes (plan/12 §1)
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
    // Protective exits are judged before new decisions: a bar that both hits a
    // stop and sets up an entry must close the position first (plan/14 §5).
    await exitEngine.onCandleClosed(candle);
    // Refresh the market view BEFORE strategies decide, so the gate they are
    // checked against reflects the bar they are deciding on.
    await marketBias.refresh();
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
    enabledConfigs.set(config.strategyId, {
      symbols: config.symbols,
      ...(config.riskRules === undefined ? {} : { riskRules: config.riskRules }),
    });
    await runner.enable(config);
  }

  // Seed the candle window from the bars already on disk (plan/18 §4 does the
  // same for indicators). The window was in-memory only and started empty, so
  // after a restart `context.candles` was blank: session-anchored logic could
  // not see the session it was in, and swing-based stops silently degraded to
  // percentage fallbacks. The bars were in Mongo the whole time — nothing read
  // them back.
  for (const symbol of [
    ...new Set([
      ...deriveWorkingSet(enabledConfigs.values()),
      ...settings.indexSymbols,
    ]),
  ]) {
    for (const interval of MARKET_INTERVALS) {
      const seed = await candles.loadRecent(symbol, interval, CANDLE_WINDOW);
      if (seed.length > 0) candleWindows.set(`${symbol}|${interval}`, seed);
    }
  }
  // With windows seeded, the gate has an opinion from the first bar rather
  // than sitting NEUTRAL until enough live bars accumulate.
  await marketBias.refresh();
  log.info({ marketView: marketBias.current().detail }, "market view seeded");
  // Without this the feed connects and subscribes to nothing: the socket is
  // up, the chip reads healthy, and not one tick ever arrives.
  await syncWorkingSet();
  log.info(
    { openPositions: positionEngine.getOpenPositions().length },
    "engine runtime wired",
  );

  // The day curve (plan/06 §4): sampled by a composition-root timer, served
  // by GET /pnl/curve. In-memory by design — plan/07 persists PnL daily only.
  const equityTracker = new EquityCurveTracker();
  function totalUnrealizedPnl(): number {
    let total = 0;
    for (const position of positionEngine.getOpenPositions()) {
      const price = lastPrices.get(position.symbol);
      if (price !== undefined) total += unrealizedPnl(position, price);
    }
    return total;
  }

  return {
    bus,
    positionEngine,
    setTradingEnabled(enabled) {
      state.tradingEnabled = enabled;
    },
    async enableStrategy(config) {
      enabledConfigs.set(config.strategyId, {
        symbols: config.symbols,
        ...(config.riskRules === undefined
          ? {}
          : { riskRules: config.riskRules }),
      });
      await runner.enable(config);
      await syncWorkingSet();
    },
    disableStrategy(strategyId) {
      runner.disable(strategyId);
      enabledConfigs.delete(strategyId);
      // Fire-and-forget: RuntimeControls.disableStrategy is synchronous, and
      // an unsubscribe that fails costs redundant ticks, never a missed one.
      void syncWorkingSet().catch((error: unknown) => {
        onError(error, { at: "syncWorkingSet" });
      });
    },
    applyGlobalSettings({ limits, allocatedCapital }) {
      state.limits = limits;
      state.allocatedCapital = allocatedCapital;
    },
    getOpenPositions() {
      return positionEngine.getOpenPositions();
    },
    realizedPnl() {
      return positionEngine.realizedPnl();
    },
    unrealizedPnl() {
      return totalUnrealizedPnl();
    },
    session() {
      return state.session;
    },
    equityCurve() {
      return equityTracker.points();
    },
    brokerConnection() {
      return {
        state: brokerState.state,
        connected: brokerState.state === "connected",
        since: brokerState.since,
      };
    },
    sampleEquity(now) {
      // sessionManager.phase — the PURE query; evaluate() here would consume
      // the open/close edge syncSession's event publishing depends on.
      equityTracker.sample(
        now,
        sessionManager.phase(now),
        positionEngine.realizedPnl(),
        totalUnrealizedPnl(),
      );
    },
    async syncSession(now) {
      const evaluation = sessionManager.evaluate(now);
      state.session = {
        phase: evaluation.phase,
        minutesSinceOpen: istMinuteOfDay(now) - openMinute,
        sessionOpenTs: istMinuteTs(now, openMinute),
      };
      if (evaluation.phaseChanged) {
        // Through the Market Data Engine's port, NOT a raw write. There were
        // two writers of this key and they disagreed: this one stored the
        // bare string `"open"`, the port stores `{ phase: "open" }`, and the
        // Paper Broker reads `.phase`. So `readSessionOpen()` was permanently
        // false and every paper order was refused "market is closed" — while
        // the golden run, which hardcodes the session open, stayed green.
        // One writer, one shape (plan/02 §8: sole writer).
        await marketDataPorts.writeHotSession(evaluation.phase);
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
      // Intraday square-off (plan/13 §6): flatten before the close, while the
      // session is still open enough for risk to approve the exits. Runs on the
      // session tick rather than on MARKET_CLOSE — by the close it is too late,
      // the Risk Engine's session check would block every exit order.
      if (evaluation.phase === "open") {
        await exitEngine.onSessionTick(
          now,
          istMinuteTs(now, parseHHMM(settings.marketHours.squareOff)),
        );
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
