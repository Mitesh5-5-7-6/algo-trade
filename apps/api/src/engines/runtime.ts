import { randomUUID } from "node:crypto";
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
  OptionChainSnapshot,
} from "@neelkanth/core";
import type { EventName, EventPayload } from "@neelkanth/contracts";
import { componentLogger, type Logger } from "@neelkanth/logger";
import {
  createEventBus,
  hotPriceKey,
  hotSessionKey,
  riskDailyLossKey,
  type EventBus,
  type RedisConnections,
} from "@neelkanth/redis";
import {
  CandlesRepository,
  OrdersRepository,
  PaperBrokerOrdersRepository,
  PaperReconciliationsRepository,
  PnlSnapshotsRepository,
  PositionsRepository,
  RiskEventsRepository,
  RiskLogsRepository,
  SettingsRepository,
  SignalsRepository,
  TradeCardsRepository,
  StrategiesRepository,
  TradesRepository,
  StrategyStateRepository,
  type MongoConnection,
} from "@neelkanth/db";
import type { Broker, HistoryProvider } from "@neelkanth/broker";
import { fyersNormalizer } from "./fyers-normalizer.js";
import {
  portfolioForStrategy,
  EquityCurveTracker,
  ExitEngine,
  IndicatorEngine,
  DailyLossLedger,
  MarketBiasEngine,
  MarketDataEngine,
  OrderManager,
  PnlEngine,
  PositionEngine,
  provisionSeries,
  RiskEngine,
  SessionManager,
  StrategyRunner,
  TradeEngine,
  unrealizedPnl,
  type IndicatorPorts,
  type MarketDataPorts,
  type OrderPorts,
  type PnlPorts,
  type PositionPorts,
  type RiskPorts,
  type StrategyPorts,
} from "@neelkanth/engines";
import { istDateKey, optionTypeForSide, startOfDayIST } from "@neelkanth/core";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { loadInstrumentMaster } from "./load-instruments.js";
import type { LiveMarketState } from "./live-market-state.js";
import { reconcilePaperBook } from "./paper-reconciliation.js";
import { instrumentLookup } from "./synthetic-index.js";
import { FEED_SILENCE_MS, feedSilentSeconds } from "./feed-health.js";
import { catchUpSession } from "./session-catch-up.js";
import { buildTradeCard, optionUnderlyingOf } from "../signals/trade-card.js";
import { oddsForCard, type AskOdds } from "../signals/card-odds.js";
import type { RuntimeControls } from "../control-plane/controls.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
/**
 * Bars kept per (symbol, interval). Sized to span a full NSE session at 5m
 * (09:15–15:30 is 75 bars): a strategy that anchors on the session — ORB reads
 * its opening range out of this window — must still be able to see the open
 * from a cold start late in the day.
 */
const CANDLE_WINDOW = 90;

/**
 * TTL on the `hot:*` inspection keys. Comfortably longer than their refresh
 * interval (one minute for prices), short enough that a stopped engine stops
 * looking live.
 */
const HOT_KEY_TTL_SECONDS = 300;

/**
 * How long a day's realized-loss record survives (§0.5.4).
 *
 * Two days, not two hours: the counter must outlive an overnight restart and
 * a weekend is covered by the date in the key. Long enough to be useful, short
 * enough that the keyspace does not accumulate a row per trading day forever.
 */
const DAILY_LOSS_TTL_SECONDS = 2 * 86_400;

const OPTION_CHAIN_CACHE_MS = 30_000;

/** The intervals the aggregator builds, and therefore the ones we can seed. */
const MARKET_INTERVALS = [
  "1m",
  "5m",
] as const satisfies readonly CandleInterval[];

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
  /** The risk limits in force now — read by the notifier for daily-loss warnings (task 16.4). */
  riskLimits(): RiskLimits;
  readonly bus: EventBus;
  readonly positionEngine: PositionEngine;
  /** Publish a fresh option-chain snapshot for the underlying, so chain-dependent strategies can read it synchronously. */
  setOptionChainSnapshot(snapshot: {
    underlying: string;
    expiry: number;
    asOf: number;
    spot: number;
    rows: Array<{
      strike: number;
      callOI: number;
      putOI: number;
      callChangeOI: number;
      putChangeOI: number;
      callIV?: number;
      putIV?: number;
    }>;
  }): void;
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
  paperOrderMonitor?: {
    onMarketTick(tick: {
      symbol: string;
      ltp: number;
      ts: number;
    }): Promise<void>;
    expirePendingOrders(): Promise<void>;
  };
  /** Stamped on every order and fill event — the audit trail (plan/12 §4). */
  mode: TradeMode;
  /**
   * The shared in-memory price/session state (see `live-market-state.ts`).
   * The runtime writes it; the Paper Broker reads it.
   */
  liveState: LiveMarketState;
  /**
   * The broker's history, for the bars a late feed missed (task 15.3). Absent,
   * a feed that connects after the open trades on what it saw.
   */
  history?: Pick<HistoryProvider, "getHistory">;
  /**
   * The research service's Time Machine, for a trade card's odds (operator
   * decision 2026-11-18). Absent, cards go out without odds and say why.
   */
  askOdds?: AskOdds;
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
  const paperBook =
    deps.mode === "paper" ? new PaperBrokerOrdersRepository(db) : null;
  const paperReconciliations = new PaperReconciliationsRepository(db);
  const riskEvents = new RiskEventsRepository(db);
  const riskLogs = new RiskLogsRepository(db);
  const pnlSnapshots = new PnlSnapshotsRepository(db);
  const candles = new CandlesRepository(db);
  const trades = new TradesRepository(db);
  const strategiesRepo = new StrategiesRepository(db);
  const strategyState = new StrategyStateRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const tradeCards = new TradeCardsRepository(db);
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
  // Shared with the Paper Broker so execution prices and decision prices are
  // the same number, from the same place.
  const lastPrices = deps.liveState.prices;
  const optionChainRequests = new Map<
    string,
    { fetchedAt: number; request?: Promise<OptionChainSnapshot | null> }
  >();
  const candleWindows = new Map<string, Candle[]>();
  // Symbols ride along with the risk rules because the market-data working
  // set is derived from them: subscribing is not a side effect of enabling a
  // strategy, it IS how an enabled strategy receives anything at all.
  const enabledConfigs = new Map<
    string,
    {
      riskRules?: RiskRules;
      symbols: readonly string[];
      /** The strategy's own capital (2026-11-18), when it has one. */
      allocatedCapital?: number;
    }
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

  /**
   * The kill gate's one writer, announcing each real change with who made it
   * (task 16.3): pause, kill and a reconciliation mismatch halt; only the
   * operator resumes. On the transition only — a second pause is not a second
   * halt — so the operator is told once.
   */
  function switchTrading(
    change:
      | {
          readonly enabled: false;
          readonly source: "pause" | "kill" | "reconciliation";
          readonly reason: string;
        }
      | { readonly enabled: true; readonly source: "operator" },
  ): void {
    const was = state.tradingEnabled;
    state.tradingEnabled = change.enabled;
    if (was === change.enabled) return;
    const ts = Date.now();
    const sent = change.enabled
      ? publish("TRADING_RESUMED", { source: "operator", mode: deps.mode, ts })
      : publish("TRADING_HALTED", {
          source: change.source,
          reason: change.reason,
          mode: deps.mode,
          ts,
        });
    sent.catch((error: unknown) => {
      onError(error, { at: "publish trading switch" });
    });
  }

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
    holidays: settings.marketHolidays,
    exchange: "NSE",
  });

  /**
   * Hot-state writes (Redis; the cross-process / inspection copy).
   *
   * Always with a TTL. These keys used to be written with a bare SET, so a
   * stopped engine left its last price and session phase in Redis forever —
   * indistinguishable, to any reader, from live state. An expiring key says
   * "nobody is publishing this any more", which is the truthful answer.
   */
  const writeHot = (key: string, value: unknown): Promise<unknown> =>
    redis.client.set(key, JSON.stringify(value), "EX", HOT_KEY_TTL_SECONDS);

  // --- Market Data Engine (Inbound) ---
  const marketDataPorts: MarketDataPorts = {
    writeHotSession: (phase) =>
      writeHot(hotSessionKey(), { phase }).then(() => undefined),
    // The repository reports whether the write was applied; a live bar is
    // refused when a higher-ranked one (a broker backfill of the same minute)
    // is already stored. That is the precedence rule working as intended, not
    // an error, and the tick path has nothing to do differently — so the
    // boolean is deliberately dropped here rather than widening the port.
    saveCandle: (candle) => candles.upsert(candle).then(() => undefined),
    publish,
  };
  // No session manager: this runtime is the single session driver (syncSession
  // below). The engine used to take one and never be asked to use it.
  const marketDataEngine = new MarketDataEngine({
    ports: marketDataPorts,
    normalizer: fyersNormalizer,
    intervals: MARKET_INTERVALS,
    onError,
    // Only ticks stamped inside today's open session build bars (2026-11-19:
    // a connect-time snapshot stamped 04:50 drove a phantom short). Asked of
    // the session manager by the tick's own time, never the clock's.
    acceptTick: (tick) => sessionManager.phase(tick.ts) === "open",
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
  /**
   * At-the-money contracts kept subscribed for the derivative strategies
   * (plan/17 §7).
   *
   * A contract resolved at signal time has no price if it has never ticked,
   * and the runner refuses to size or trade an unpriced contract. Tracking the
   * current ATM call and put continuously means the price is already there
   * when the signal arrives. The set is recomputed as spot drifts, so it
   * follows the money rather than pinning to whatever was ATM at boot.
   */
  const trackedContracts = new Set<string>();

  const syncWorkingSet = async (): Promise<void> => {
    const traded = deriveWorkingSet(enabledConfigs.values());
    // Indices ride along for DATA only (plan/17 §7). They are never traded —
    // an index has no tradable contract — but the market-bias gate cannot read
    // direction from instruments it does not receive.
    const base = [
      ...new Set([
        ...traded,
        ...settings.indexSymbols,
        ...settings.breadthSymbols,
        ...trackedContracts,
      ]),
    ];
    // An index has no traded volume: its near-month future's stands in, so
    // VWAP and average volume can form (2026-11-18 — every live index bar
    // had volume 0, and the strategies needing them never ran). Resolved on
    // every sync, so the next contract takes over after an expiry.
    const volumeSources = new Map<string, string>();
    for (const symbol of base) {
      const underlying = optionUnderlyingOf(symbol);
      if (underlying === null) continue;
      const future = instruments.nearestFuture(underlying, Date.now());
      if (future !== null) volumeSources.set(symbol, future.symbol);
    }
    marketDataEngine.setVolumeSources(volumeSources);
    const symbols = [...new Set([...base, ...volumeSources.values()])];
    await marketDataEngine.subscribe(symbols);
    if (symbols.length === 0) {
      // A feed subscribed to nothing looks identical to a healthy one: the
      // socket connects, the status chip reads LIVE, and no tick ever arrives
      // until the broker drops the idle connection. Say so out loud.
      log.warn(
        { enabledStrategies: enabledConfigs.size },
        "market data working set is EMPTY — the feed will receive no ticks; " +
          "no strategy enabled successfully and no index symbols are configured",
      );
      return;
    }
    // Where each symbol came from, so a missing one can be traced to its
    // source: no strategy enabled, a settings list emptied, or no contract.
    log.info(
      {
        symbols,
        strategies: [...enabledConfigs].map(([strategyId, c]) => ({
          strategyId,
          symbols: c.symbols,
        })),
        traded: traded.length,
        indices: settings.indexSymbols.length,
        breadth: settings.breadthSymbols.length,
        contracts: trackedContracts.size,
        volumeFrom: Object.fromEntries(volumeSources),
      },
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

  // The outcome projection (ADR §9.2). Runs alongside the Position Engine
  // on the same fills and keyed the same way: the position says what is
  // held now, the trade says what one decision earned. Only the second is
  // something research can label.
  const tradeEngine = new TradeEngine({
    ports: {
      saveTrade: (trade) => trades.save(trade),
      loadOpenTrades: () => trades.findAllOpen(),
      findTradeByOrderId: (orderId) => trades.findByOrderId(orderId),
      // In-memory, and safe because the fill handler awaits the Position
      // Engine first — see the ORDER_FILLED subscription below.
      resolvePositionId: (strategyId, symbol) =>
        positionEngine.getPosition(strategyId, symbol)?.positionId ?? null,
    },
    nextTradeId: () => `trd_${randomUUID()}`,
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
  let brokerUpdateChain: Promise<void> = Promise.resolve();
  deps.broker.onOrderUpdate((update) => {
    brokerUpdateChain = brokerUpdateChain
      .then(() => orderManager.onBrokerUpdate(update))
      .catch((error: unknown) => {
        onError(error, { where: "broker order update", update });
      });
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
    breadthSymbols: () => settings.breadthSymbols,
    bars: CANDLE_WINDOW,
    onError,
  });

  // --- Daily-loss durability (§0.5.4) ---
  // Redis rather than Mongo: `risk:dailyLoss:<date>` is the key the namespace
  // table already reserved for exactly this, it is written a few dozen times a
  // day rather than per tick, and the figure is worthless the moment its
  // trading day ends — which is what a TTL expresses and a collection does not.
  const dailyLoss = new DailyLossLedger({
    ports: {
      read: async (dateIST: string) => {
        const raw = await redis.client.get(riskDailyLossKey(dateIST));
        if (raw === null) return null;
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          // A corrupt counter is not a fresh day. Returning null here would
          // silently restart the day at zero, which is the exact failure this
          // ledger exists to prevent.
          throw new Error(
            `unreadable daily-loss counter for ${dateIST}: ${raw}`,
          );
        }
        return value;
      },
      write: async (dateIST: string, realizedPnl: number) => {
        await redis.client.set(
          riskDailyLossKey(dateIST),
          String(realizedPnl),
          "EX",
          DAILY_LOSS_TTL_SECONDS,
        );
      },
    },
    onError,
  });

  // --- Risk Engine ---
  const riskPorts: RiskPorts = {
    readSession: () => Promise.resolve<SessionPhase>(state.session.phase),
    // Through the ledger, which THROWS when the day's loss is unknown — the
    // Risk Engine turns that into a fail-closed block (plan/14 §9). Returning
    // zero instead would be indistinguishable from a genuinely flat day, and
    // the gate would wave through the trades it exists to stop.
    readDailyRealizedLoss: () =>
      Promise.resolve(
        dailyLoss.lossFrom(
          positionEngine.realizedPnl(),
          istDateKey(Date.now()),
        ),
      ),
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
    readPortfolio: (strategyId) => {
      const p = portfolioForStrategy({
        strategyId,
        allocation:
          strategyId === undefined
            ? undefined
            : enabledConfigs.get(strategyId)?.allocatedCapital,
        openPositions: positionEngine.getOpenPositions(),
        priceOf: (s) => lastPrices.get(s) ?? null,
        accountCapital: state.allocatedCapital,
        accountRealizedToday: positionEngine.realizedPnl(),
        strategyRealizedToday: (id) =>
          positionEngine.realizedPnlForStrategy(id),
      });
      return Promise.resolve({
        allocatedCapital: p.allocatedCapital,
        investedValue: p.investedValue,
        availableCapital: p.availableCapital,
      });
    },
    entriesClosed: () => {
      const now = Date.now();
      return now >= istMinuteTs(now, parseHHMM(settings.marketHours.squareOff));
    },
    readGlobalLimits: () => Promise.resolve(state.limits),
    readStrategyOverride: (strategyId) =>
      Promise.resolve(enabledConfigs.get(strategyId)?.riskRules ?? null),
    readMarketView: () => marketBias.current(),
    readInstrument: instrumentLookup(deps.mode, (symbol) =>
      instruments.get(symbol),
    ),
    persistRiskLog: (logEntry) => riskLogs.insert(logEntry),
    publish,
  };
  const risk = new RiskEngine({ ports: riskPorts, onError });

  // --- Indicator Engine ---
  const indicatorPorts: IndicatorPorts = {
    // `hot:indicators:*` is no longer written. It was a SET per closed bar per
    // symbol with no TTL and NO production reader anywhere — pure write
    // amplification against a key nothing consumed. Strategies read indicators
    // from the INDICATORS_UPDATED payload, in process.
    writeHotIndicators: () => Promise.resolve(),
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
    // Strategy state across process lifetimes (§0.5.6). Without these a
    // restart at 11:00 came back not knowing where the morning's opening
    // range was, and held for a level it could no longer see.
    loadStrategyState: (strategyId, symbol) =>
      strategyState.load(strategyId, symbol),
    saveStrategyState: (state) => strategyState.save(state),
    readOptionChain: async (underlying: string) => {
      const now = Date.now();
      const cached = deps.liveState.optionChains.get(underlying);
      const request = optionChainRequests.get(underlying);
      if (cached !== undefined && now - cached.asOf < OPTION_CHAIN_CACHE_MS) {
        return cached;
      }
      if (request?.request !== undefined) return request.request;

      const fetchRequest =
        deps.broker.readOptionChain?.(underlying) ??
        Promise.resolve<OptionChainSnapshot | null>(null);
      optionChainRequests.set(underlying, {
        fetchedAt: now,
        request: fetchRequest,
      });
      try {
        const snapshot = await fetchRequest;
        if (snapshot !== null)
          deps.liveState.optionChains.set(underlying, snapshot);
        return snapshot;
      } finally {
        optionChainRequests.delete(underlying);
      }
    },
    resolveContract: (target, side, spot, now) =>
      target.kind === "FUTURE"
        ? instruments.nearestFuture(target.underlying, now)
        : instruments.nearestOption(
            target.underlying,
            spot,
            optionTypeForSide(side),
            now,
            target.strikeOffset,
          ),
    readPrice: (symbol) => lastPrices.get(symbol) ?? null,
    persistSignal: (signal) => signals.insert(signal),
    publish,
  };
  const handoff = async (signal: Signal): Promise<void> => {
    const decision = await risk.validate(signal); // synchronous critical path
    if (decision.decision === "approved") {
      const result = await orderManager.place(signal, decision);
      // The operator's card for the entry — after the order, never before it,
      // and never in its way: a failure here is logged and nothing else.
      if (result.status !== "rejected" && result.status !== "halted")
        void publishTradeCard(signal).catch((error: unknown) => {
          onError(error, { where: "tradeCard", signalId: signal.signalId });
        });
    }
  };

  /**
   * What to trade for an approved entry (operator decision 2026-11-18): the
   * contract, its buy price, stop and target. An option strategy's card is its
   * own order's numbers; an index strategy's suggests the at-the-money call
   * or put at its live premium, its stop and target estimated from the index
   * levels. Stored for the dashboard and published for Telegram; nothing in
   * the order path reads either.
   */
  async function publishTradeCard(signal: Signal): Promise<void> {
    if (signal.side === "HOLD") return;
    const now = Date.now();
    const underlying = optionUnderlyingOf(signal.symbol);
    const contract =
      signal.underlyingSymbol !== undefined
        ? instruments.get(signal.symbol)
        : underlying === null
          ? null
          : instruments.nearestOption(
              underlying,
              signal.contextSnapshot.price,
              optionTypeForSide(signal.side),
              now,
            );
    const config = await strategiesRepo.findById(signal.strategyId);
    const card = buildTradeCard(signal, {
      strategyName: config?.name ?? signal.strategyId,
      contract,
      premium:
        contract === null ? null : (lastPrices.get(contract.symbol) ?? null),
    });
    if (card === null) return;
    await tradeCards.insert(card);
    // The Time Machine's odds for the plan, asked of the research service —
    // the order is already placed, so this can only delay the message, by at
    // most the client's timeout. Unanswered, the card says so and goes out.
    const odds = await oddsForCard(
      card,
      {
        spot: lastPrices.get(card.underlying) ?? null,
        rule:
          config === null ? null : { type: config.type, params: config.params },
        indexSymbols: settings.indexSymbols,
      },
      deps.askOdds ?? null,
    );
    await tradeCards.setOdds(card.signalId, odds);
    await publish("TRADE_CARD", { ...card, odds, mode: deps.mode });
  }
  const runner = new StrategyRunner({
    registry: createStrategyRegistry(),
    ports: strategyPorts,
    provisionIndicators: async (symbol, interval, specs) => {
      provisionSeries(indicatorEngine, symbol, interval, specs);
      await indicatorEngine.warmUp(symbol, interval);
    },
    handoff,
    nextSignalId: () => `sig_${crypto.randomUUID()}`,
    candleWindow: CANDLE_WINDOW,
    // Live: a strategy waiting on its indicators says so (2026-11-18).
    recordNotReady: true,
    onError,
  });

  // --- Exit Engine: stops, targets, and the intraday square-off ---
  const exitEngine = new ExitEngine({
    ports: {
      readOpenPositions: () => positionEngine.getOpenPositions(),
      readSession: () => Promise.resolve(state.session),
      persistSignal: (signal) => signals.insert(signal),
      // Durable half of the exit guard (Phase 3 D3). The in-memory Set dies
      // with the process, and the window it protects — handed off, fill not
      // back — is exactly the one a restart lands in.
      hasExitInFlight: (positionId) => orders.hasExitInFlight(positionId),
      // From the runner rather than the database: asked on every closed bar
      // for every open position (D2).
      readExitRules: (strategyId) => runner.exitRulesFor(strategyId),
      // Both halves of a trail (D4): in memory so the next bar is judged
      // against it, and durably so a restart does not hand the position back
      // its entry stop and silently widen the risk.
      updateStopLoss: async (positionId, stopLoss) => {
        positionEngine.setStopLoss(positionId, stopLoss);
        await positions.setStopLoss(positionId, stopLoss);
      },
    },
    // The same risk→order road a strategy signal takes (plan/12 §1), saying
    // whether an order came of it (audit A7): a blocked or rejected exit
    // leaves nothing live, so the engine must try again rather than skip
    // the position until a restart.
    handoff: async (signal) => {
      const decision = await risk.validate(signal);
      if (decision.decision !== "approved") return { placed: false };
      const result = await orderManager.place(signal, decision);
      return {
        placed: result.status !== "rejected" && result.status !== "halted",
      };
    },
    nextSignalId: () => `sig_${crypto.randomUUID()}`,
    onError,
  });

  /**
   * When the last tick arrived, and whether we have already complained.
   *
   * A connected feed that delivers nothing is the hardest failure to see: the
   * socket is up, the status chip reads LIVE, and the only symptom is that
   * nothing ever happens. Checked on the session tick so it names itself.
   */
  let lastTickAt = 0;
  let silenceReported = false;

  /**
   * Keep the current ATM call and put subscribed for any derivative strategy
   * watching `symbol`.
   *
   * Both sides, always: which one a signal needs is not known until it fires,
   * and subscribing then would be a bar too late. Only re-syncs the feed when
   * the set actually changes, so a session's worth of candle closes does not
   * mean a session's worth of resubscriptions.
   */
  const trackAtmContracts = async (
    symbol: string,
    spot: number,
  ): Promise<void> => {
    const targets = runner
      .derivativeTargets()
      .filter((entry) => entry.symbol === symbol);
    if (targets.length === 0) return;
    const now = Date.now();
    let changed = false;
    for (const { target } of targets) {
      const contracts =
        target.kind === "FUTURE"
          ? [instruments.nearestFuture(target.underlying, now)]
          : (["CE", "PE"] as const).map((type) =>
              instruments.nearestOption(
                target.underlying,
                spot,
                type,
                now,
                target.strikeOffset,
              ),
            );
      for (const contract of contracts) {
        if (contract === null || trackedContracts.has(contract.symbol))
          continue;
        trackedContracts.add(contract.symbol);
        changed = true;
      }
    }
    if (changed) await syncWorkingSet();
  };

  // --- Bus wiring ---
  const appendWindow = (candle: Candle): void => {
    const key = `${candle.symbol}|${candle.interval}`;
    const window = candleWindows.get(key) ?? [];
    window.push(candle);
    if (window.length > CANDLE_WINDOW) window.shift();
    candleWindows.set(key, window);
  };
  await bus.subscribe("MARKET_TICK", async (event) => {
    lastPrices.set(event.payload.symbol, event.payload.ltp);
    lastTickAt = Date.now();
    await deps.paperOrderMonitor?.onMarketTick(event.payload);
  });
  await bus.subscribe("CANDLE_CLOSED", async (event) => {
    const candle = event.payload;
    lastPrices.set(candle.symbol, candle.close);
    appendWindow(candle);
    // The cross-process copy of the price, refreshed here rather than per tick
    // (plan/08 §5). One write per symbol per bar instead of one per tick —
    // roughly a hundredth of the commands, for a key production reads a
    // handful of times a day. Failure is non-fatal: nothing in the trading
    // path depends on it.
    if (candle.interval === "1m") {
      void writeHot(hotPriceKey(candle.symbol), {
        symbol: candle.symbol,
        ltp: candle.close,
        volume: candle.volume,
        ts: candle.ts,
      }).catch((error: unknown) => {
        onError(error, { where: "writeHotPrice", symbol: candle.symbol });
      });
    }
    runner.onCandleClosed(candle); // cache the bar for the indicator update
    // Protective exits are judged before new decisions: a bar that both hits a
    // stop and sets up an entry must close the position first (plan/14 §5).
    await exitEngine.onCandleClosed(candle);
    // Refresh the market view BEFORE strategies decide, so the gate they are
    // checked against reflects the bar they are deciding on.
    await marketBias.refresh();
    await trackAtmContracts(candle.symbol, candle.close);
    await indicatorEngine.onCandleClosed(candle); // → INDICATORS_UPDATED
  });
  await bus.subscribe("INDICATORS_UPDATED", (event) =>
    runner.onIndicatorsUpdated(event.payload),
  );
  // Fills are projected one at a time, in the order published (§2.7). The bus
  // does not await its handlers, so two fills in flight interleaved at every
  // await below: the Trade Engine was reached in the order the POSITION
  // WRITES returned, and a round trip whose exit was published while its entry
  // was still persisting was recorded backwards — a SHORT entered on the SELL.
  // Chained, each fill finishes before the next starts, so "position before
  // trade" holds per fill and a slow write can never be overtaken.
  let fillChain: Promise<void> = Promise.resolve();
  await bus.subscribe("ORDER_FILLED", (event) => {
    fillChain = fillChain
      .then(async () => {
        // Position first: the system's view of what it holds is the thing
        // that must never be wrong. It also has to land before the Trade
        // Engine, which reads the position it just built for `positionId`.
        await positionEngine.onOrderFilled(event.payload);
        // Then the outcome record. Its own failures are swallowed into
        // onError, so a lost trade row cannot take the position down with it.
        await tradeEngine.onOrderFilled(event.payload);
        // And the strategy learns its proposal became a trade (§0.5.5).
        runner.onOrderFilled(event.payload);
      })
      // A failure must not stall every fill queued behind it.
      .catch((error: unknown) => {
        onError(error, {
          where: "ORDER_FILLED",
          orderId: event.payload.orderId,
        });
      });
    return fillChain;
  });
  // The rest of the signal-outcome loop. Without these a one-shot strategy
  // that was blocked or rejected would sit on a spent latch for the session.
  await bus.subscribe("ORDER_PLACED", (event) => {
    runner.onOrderPlaced(event.payload);
  });
  await bus.subscribe("ORDER_REJECTED", (event) => {
    runner.onOrderRejected(event.payload);
  });
  await bus.subscribe("RISK_BLOCKED", (event) => {
    runner.onRiskBlocked(event.payload);
  });
  await bus.subscribe("POSITION_UPDATED", async () => {
    await pnl.refresh();
    // Realized P&L may have moved, so the durable copy of it must follow. The
    // in-memory counter is already right; this is what makes it survive the
    // process.
    await dailyLoss.persist(
      istDateKey(Date.now()),
      positionEngine.realizedPnl(),
    );
  });

  const drainFills = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fillChain;
  };
  const drainBrokerUpdates = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await brokerUpdateChain;
    await drainFills();
  };

  const reconcilePaper = async (
    now: number,
    at: "BOOT" | "CLOSE",
  ): Promise<void> => {
    if (paperBook === null) return;
    const event = await reconcilePaperBook({
      findOpenPositions: () => positionEngine.getOpenPositions(),
      findOrders: (from, toExclusive) =>
        orders.findAllByDateRange(from, toExclusive),
      findInFlightOrders: () => orders.findByStatus(["PLACED", "PENDING"]),
      findOrder: (orderId) => orders.findByOrderId(orderId),
      findBookOrders: (from) => paperBook.recordedSince(from),
      findBookOrder: (orderId) => paperBook.find(orderId),
      findAllFills: () => paperBook.allFills(),
      disableTrading: async () => {
        switchTrading({
          enabled: false,
          source: "reconciliation",
          reason: `paper broker reconciliation mismatch at ${at}`,
        });
        await settingsRepo.setTradingEnabled(false);
      },
      persistRiskEvent: (event) => riskEvents.insert(event),
      publishMismatch: (event) =>
        publish("SYSTEM_ERROR", {
          source: "broker.reconciliation",
          level: "error",
          message:
            "Paper broker reconciliation mismatch; trading remains disabled " +
            "until the operator resolves the mismatch and resumes trading",
          context: {
            riskEventId: event.riskEventId,
            mismatches: event.mismatches,
          },
          ts: event.ts,
        }),
      reconcileClose: async (order, brokerFill) => {
        if (
          order.filledPrice !== brokerFill.filledPrice ||
          order.filledAt !== brokerFill.filledAt
        ) {
          throw new Error(
            `broker reconciliation close ${order.orderId} has inconsistent broker details`,
          );
        }
        await orderManager.recordBrokerReconciliationClose(order);
        await drainFills();
      },
      now: () => now,
    });
    // Recorded clean or not (D6): a clean run leaves nothing in risk_events,
    // and the session report must still be able to say it ran — and each
    // BOOT run is how a mid-session restart is known.
    await paperReconciliations.insert({
      runId: `recon_${randomUUID()}`,
      session: istDateKey(now),
      at,
      ts: now,
      clean: event === null,
      mismatches: event?.mismatches.length ?? 0,
      ...(event === null ? {} : { riskEventId: event.riskEventId }),
    });
  };

  // --- Boot sequence (plan/05 §3, plan/22 §4) ---
  // Hydrate open positions, reconcile stuck orders, then enable strategies
  // (which registers + warms their indicators). The kill flag was honored by
  // the composition root before this point.
  positionEngine.hydrate(await positions.findOpen());
  // Open trades too, or a restart mid-position opens a SECOND trade on the
  // next fill and leaves the first open forever — one position recorded as
  // two trades, neither of them true.
  await tradeEngine.hydrate();
  // The day's realized loss, restored BEFORE anything can trade (§0.5.4).
  // Not in the optional warm-up block below: a boot that cannot read this does
  // not know whether the daily-loss limit is already breached, and the ledger
  // deliberately leaves the gate fail-closed rather than letting the afternoon
  // start from a clean slate.
  {
    const today = istDateKey(Date.now());
    const restored = await dailyLoss.hydrate(today);
    if (restored === null) {
      log.info({ date: today }, "daily realized P&L: no record yet for today");
    } else {
      positionEngine.seedDailyRealized(restored);
      log.info(
        { date: today, realizedPnl: restored },
        "daily realized P&L restored from the ledger",
      );
    }
  }
  for (const order of await orders.findByStatus(["PLACED", "PENDING"])) {
    await orderManager.reconcile(order);
  }
  await drainFills();
  await reconcilePaper(Date.now(), "BOOT");
  for (const config of await strategiesRepo.findEnabled()) {
    enabledConfigs.set(config.strategyId, {
      symbols: config.symbols,
      ...(config.riskRules === undefined
        ? {}
        : { riskRules: config.riskRules }),
      ...(config.allocatedCapital === undefined
        ? {}
        : { allocatedCapital: config.allocatedCapital }),
    });
    try {
      await runner.enable(config);
    } catch (error) {
      // One unusable strategy must not take the whole engine down with it.
      //
      // This loop was unguarded, so an unknown `type`, params that fail their
      // schema, or a throwing indicator provision aborted the rest of the boot
      // sequence — including `syncWorkingSet()`. The feed then had an empty
      // working set, and BOTH subscribe paths skip silently on an empty list,
      // so the socket connected, subscribed to nothing, and was dropped by the
      // broker's idle timeout roughly every two minutes. No ticks, no candles,
      // no evaluations, and nothing anywhere saying why.
      enabledConfigs.delete(config.strategyId);
      onError(error, {
        where: "enableStrategy",
        strategyId: config.strategyId,
        type: config.type,
        note: "strategy skipped; the rest of the engine continues",
      });
    }
  }

  // Seed the candle window from the bars already on disk (plan/18 §4 does the
  // same for indicators). The window was in-memory only and started empty, so
  // after a restart `context.candles` was blank: session-anchored logic could
  // not see the session it was in, and swing-based stops silently degraded to
  // percentage fallbacks. The bars were in Mongo the whole time — nothing read
  // them back.
  // Everything from here to the feed subscription is an OPTIMISATION: warm
  // windows and a seeded market view make the first bars better, but the
  // engine is still correct without them. The subscription is not optional —
  // without it the socket connects, subscribes to nothing, and is dropped by
  // the broker's idle timeout every two minutes. So none of this is allowed
  // to stand between a boot hiccup and a working feed.
  try {
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
  } catch (error) {
    onError(error, {
      where: "seedWindows",
      note: "starting with cold windows; the feed still subscribes",
    });
  }

  // Task 15.3: a feed that connects after the open has missed bars — on
  // 2026-11-18 it connected at 09:29, when the operator logged in, and the
  // opening range was one partial bar of three. The broker's history still
  // holds them. Fetched, stored at their higher rank and reloaded into the
  // windows — never published, so no strategy trades a bar that is gone. Run
  // on connect, and once more just after the next 5-minute bar closes, which
  // replaces the bar the live feed built from its first ticks alone.
  // Indicators are left as they are: re-folding bars into a warm fold would
  // count them twice, and a few early bars move a slow average very little.
  let catchUpRunning = false;
  let catchUpFollowUp: ReturnType<typeof setTimeout> | null = null;
  const runCatchUp = async (reason: string): Promise<void> => {
    const history = deps.history;
    const now = Date.now();
    if (history === undefined || catchUpRunning) return;
    if (sessionManager.phase(now) !== "open") return;
    catchUpRunning = true;
    try {
      const symbols = [
        ...new Set([
          ...deriveWorkingSet(enabledConfigs.values()),
          ...settings.indexSymbols,
        ]),
      ];
      const items = await catchUpSession(
        {
          now,
          sessionOpenTs: istMinuteTs(now, openMinute),
          symbols,
          intervals: MARKET_INTERVALS,
        },
        { history, save: (candle) => candles.upsert(candle) },
      );
      for (const item of items) {
        if (item.stored === 0) continue;
        candleWindows.set(
          `${item.symbol}|${item.interval}`,
          await candles.loadRecent(item.symbol, item.interval, CANDLE_WINDOW),
        );
      }
      log.info(
        {
          reason,
          stored: items.reduce((n, i) => n + i.stored, 0),
          failed: items
            .filter((i) => i.error !== undefined)
            .map((i) => `${i.symbol} ${i.interval}: ${i.error ?? ""}`),
        },
        "session catch-up: missed bars fetched from the broker's history",
      );
    } catch (error) {
      onError(error, { where: "sessionCatchUp", reason });
    } finally {
      catchUpRunning = false;
    }
  };
  deps.broker.onConnectionChange((next) => {
    if (next !== "connected" || deps.history === undefined) return;
    void runCatchUp("feed connected");
    if (catchUpFollowUp !== null) clearTimeout(catchUpFollowUp);
    const now = Date.now();
    const nextFiveMinute = (Math.floor(now / 300_000) + 1) * 300_000;
    catchUpFollowUp = setTimeout(
      () => {
        catchUpFollowUp = null;
        void runCatchUp("the first live bar after connecting closed");
      },
      nextFiveMinute + 60_000 - now,
    );
    catchUpFollowUp.unref();
  });

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
    setOptionChainSnapshot(snapshot) {
      deps.liveState.optionChains.set(snapshot.underlying, {
        underlying: snapshot.underlying,
        expiry: snapshot.expiry,
        asOf: snapshot.asOf,
        spot: snapshot.spot,
        rows: snapshot.rows,
      });
    },
    setTradingEnabled(change) {
      switchTrading(
        change.enabled
          ? change
          : {
              enabled: false,
              source: change.source,
              reason:
                change.source === "kill"
                  ? "operator kill switch"
                  : "operator pause",
            },
      );
    },
    async enableStrategy(config) {
      enabledConfigs.set(config.strategyId, {
        symbols: config.symbols,
        ...(config.riskRules === undefined
          ? {}
          : { riskRules: config.riskRules }),
        ...(config.allocatedCapital === undefined
          ? {}
          : { allocatedCapital: config.allocatedCapital }),
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
    async exitPositionNow(positionId) {
      return exitEngine.exitNow(positionId, Date.now());
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
    riskLimits() {
      return state.limits;
    },
    equityCurve() {
      return equityTracker.points();
    },
    brokerConnection() {
      const connected = brokerState.state === "connected";
      const silentSeconds = feedSilentSeconds({
        connected,
        marketOpen: state.session.phase === "open",
        since: brokerState.since,
        lastTickAt,
        now: Date.now(),
      });
      return {
        state: brokerState.state,
        connected,
        since: brokerState.since,
        ...(silentSeconds === null
          ? {}
          : {
              silentSeconds,
              detail:
                `Connected, but no market data for ${String(silentSeconds)}s ` +
                "while the market is open — the subscription is not " +
                'delivering. The "fyers feed:" log lines say why.',
            }),
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
      // The Paper Broker's session gate reads this, not Redis — one source for
      // "is the market open", which is what the two-writers bug above was.
      deps.liveState.sessionOpen = evaluation.phase === "open";

      // A connected feed delivering nothing is indistinguishable from a quiet
      // market on the dashboard, and it is what a dropped subscription looks
      // like. Named once when it starts and once when it recovers.
      if (evaluation.phase === "open" && brokerState.state === "connected") {
        const silentFor = now - lastTickAt;
        if (lastTickAt === 0 || silentFor > FEED_SILENCE_MS) {
          if (!silenceReported) {
            silenceReported = true;
            const silentSeconds =
              lastTickAt === 0 ? null : Math.round(silentFor / 1000);
            const subscribed = deriveWorkingSet(enabledConfigs.values()).length;
            log.warn(
              {
                lastTickAt: lastTickAt === 0 ? null : lastTickAt,
                silentSeconds,
                subscribed,
              },
              "FEED SILENT — broker connected and market open, but no ticks " +
                "are arriving; check the working set and the broker subscription",
            );
            // Task 16.3: an event too, so the operator can be told, not only
            // the log reader.
            await publish("FEED_SILENT", {
              broker: "fyers",
              mode: deps.mode,
              silentSeconds,
              subscribed,
              ts: now,
            });
          }
        } else if (silenceReported) {
          silenceReported = false;
          log.info({}, "feed recovered — ticks are arriving again");
          await publish("FEED_RECOVERED", {
            broker: "fyers",
            mode: deps.mode,
            ts: now,
          });
        }
      }
      if (evaluation.marketOpened) {
        // Today's near-month futures for index volume (a rollover lands here).
        await syncWorkingSet();
        indicatorEngine.onMarketOpen();
        positionEngine.resetDaily();
        // A new trading day starts at zero, durably — otherwise a restart later
        // today would restore yesterday's losses under today's date.
        await dailyLoss.startDay(istDateKey(now));
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
        // Close the day's last bar BEFORE anyone hears the market shut. The
        // aggregator holds each interval's final bucket open until a later tick
        // pushes it forward — and after the close no such tick arrives. Flushed
        // here, the bar is persisted while its session is still the current one;
        // left unflushed, it either died with the process overnight or surfaced
        // at the next open as a day-old CANDLE_CLOSED fed to live exits.
        await marketDataEngine.flushOpenBars();
        await bus.publish("MARKET_CLOSE", {
          exchange: "NSE",
          session: istDateKey(now),
          ts: now,
        });
        await drainFills();
        await deps.paperOrderMonitor?.expirePendingOrders();
        await drainBrokerUpdates();
        await reconcilePaper(now, "CLOSE");
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
