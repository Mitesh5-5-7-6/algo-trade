import {
  type Candle,
  type CandleInterval,
  type MarketView,
  type Order,
  type Position,
  type RiskLimits,
  type SessionContext,
  type Signal,
  type StrategyConfig,
  type Trade,
  intervalMs,
  istDateKey,
  NSE_DEFAULT_SESSION,
} from "@neelkanth/core";
import type { EventName, EventPayload } from "@neelkanth/contracts";
import { PaperBroker } from "@neelkanth/broker";
import {
  computePortfolio,
  ExitEngine,
  fixtureNormalizer,
  IndicatorEngine,
  MarketBiasEngine,
  MarketDataEngine,
  OrderManager,
  PnlEngine,
  PositionEngine,
  registerIndicatorSpec,
  RiskEngine,
  SessionManager,
  StrategyRunner,
  TradeEngine,
  type ExitHandoffOutcome,
  type ExitPorts,
  type IndicatorPorts,
  type MarketBiasConfig,
  type MarketBiasPorts,
  type MarketDataPorts,
  type OrderPorts,
  type PnlPorts,
  type PositionPorts,
  type RiskPorts,
  type StrategyPorts,
} from "@neelkanth/engines";
import { createStrategyRegistry } from "@neelkanth/strategies";

/**
 * The golden-run pipeline harness (plan/27 §4): the whole machine wired with
 * in-memory ports so a recorded day of TICKS runs end-to-end with zero
 * infrastructure. It is the determinism proof — the same fixture always
 * produces the same candles, signals, risk decisions, orders, fills, exits,
 * positions, and PnL (plan/02 Principle 1) — and a preview of the real
 * composition root (plan/05 §3): same engines, same order, fake ports instead
 * of Redis/Mongo. Everything is deterministic: counter-based ids, the tick
 * timestamp as the clock, fixed slippage/charges, no randomness.
 *
 * **It starts at ticks, not candles.** Production has no source of finished
 * bars; it has a feed. The earlier harness was handed pre-baked candles, which
 * meant normalization, aggregation and the end-of-day flush — the three steps
 * every other number in the record depends on — were never exercised, and the
 * record proved determinism over a strictly smaller machine than the one that
 * trades (CURRENT_STATE §4).
 */

/** The raw wire shape the fixture normalizer parses (see `normalize.ts`). */
export interface RawTick {
  sym: string;
  ltp: number;
  vol: number;
  ts: number;
}

export interface GoldenFixture {
  symbol: string;
  interval: CandleInterval;
  /** Every interval the aggregator builds — production builds 1m and 5m. */
  intervals: CandleInterval[];
  /** IST session-open epoch ms; drives minutesSinceOpen. */
  sessionOpenTs: number;
  ticks: RawTick[];
  strategies: StrategyConfig[];
  indexSymbols: string[];
  breadthSymbols: string[];
  biasConfig?: MarketBiasConfig;
  allocatedCapital: number;
  limits: RiskLimits;
  /**
   * A clock reading before the bell.
   *
   * The session manager reports no transition on its FIRST evaluation — it
   * does not know the prior phase, and an honest "no transition" beats a
   * fabricated one. So the harness, like the runtime, is running before the
   * open; otherwise the day would begin mid-session and MARKET_OPEN would
   * never fire.
   */
  preOpenTs: number;
  /** When the intraday flatten fires. */
  squareOffTs: number;
  /** The first clock reading after the bell — drives the flush and MARKET_CLOSE. */
  afterCloseTs: number;
}

/**
 * One trading day, as the session manager and the exits see it (D6).
 * Timestamps are epoch ms; `date` is the IST trading date.
 */
export interface ReplaySession {
  date: string;
  /** A clock reading before the bell, so the open is a real transition. */
  preOpenTs: number;
  sessionOpenTs: number;
  /** When the intraday flatten fires. */
  squareOffTs: number;
  /** The first clock reading after the bell — drives the flush and close. */
  afterCloseTs: number;
}

/**
 * What a run is fed (D1). Ticks prove the feed half — normalisation,
 * aggregation, the flush. Stored candles are what history has: the broker's
 * record is bars, and reconstructing ticks from a bar would invent an intrabar
 * path the data does not contain. Candles enter at `CANDLE_CLOSED`, at their
 * close time; everything after that is shared.
 */
export type ReplaySource =
  { kind: "ticks"; ticks: RawTick[] } | { kind: "candles"; candles: Candle[] };

/** Everything one replay is a function of. */
export interface ReplayInput {
  /** The interval strategies and the market view decide on. */
  interval: CandleInterval;
  /** Intervals the aggregator builds from ticks (tick sources only). */
  intervals: CandleInterval[];
  source: ReplaySource;
  /** Trading days, in order. */
  sessions: ReplaySession[];
  /** Weekend dates the exchange opened (`SessionConfig.specialSessions`). */
  specialSessions?: string[];
  strategies: StrategyConfig[];
  indexSymbols: string[];
  breadthSymbols: string[];
  biasConfig?: MarketBiasConfig;
  allocatedCapital: number;
  limits: RiskLimits;
  /** Observes each closed bar, in order, as the pipeline sees it. */
  onCandleClosed?: (candle: Candle) => void;
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
  /** The protective levels, recorded because the Exit Engine acts on them. */
  stopLoss?: number;
  target?: number;
}
/**
 * A completed Trade, as research reads it (Phase 2's outcome primitive).
 * The fields that make it evidence: both orders, why it ended, the version
 * that decided it, and where the bar behind the entry came from.
 */
interface TradeRow {
  tradeId: string;
  strategyId: string;
  strategyVersion?: string;
  symbol: string;
  side: string;
  status: string;
  entryOrderId: string;
  exitOrderId?: string;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  exitReason?: string;
  grossPnl: number;
  charges: number;
  netPnl: number;
  /** The entry bar's source — LIVE_TICK here, BROKER_HISTORICAL in history. */
  entrySource?: string;
}
interface CandleCountRow {
  symbol: string;
  interval: string;
  count: number;
}

export interface GoldenRecord {
  /** Bars the aggregator produced — proof the feed half ran. */
  candles: CandleCountRow[];
  signals: SignalRow[];
  riskDecisions: RiskDecisionRow[];
  orders: OrderRow[];
  positions: PositionRow[];
  /** One per completed position lifecycle (§4.3). */
  trades: TradeRow[];
  /** Session transitions, in order, as the single session driver saw them. */
  sessionEvents: string[];
  /** The gate's verdict at the end of the day. */
  marketView: { bias: string; detail: string };
  /** Positions still open after square-off — the day must end flat. */
  openAtEnd: number;
  realizedPnl: number;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Run one replay (Phase 4). */
export async function runReplay(input: ReplayInput): Promise<GoldenRecord> {
  return new ReplayPipeline(input).run();
}

/** The golden fixture: one tick-fed session. */
export async function runGoldenPipeline(
  fixture: GoldenFixture,
): Promise<GoldenRecord> {
  return runReplay({
    interval: fixture.interval,
    intervals: fixture.intervals,
    source: { kind: "ticks", ticks: fixture.ticks },
    sessions: [
      {
        date: istDateKey(fixture.sessionOpenTs),
        preOpenTs: fixture.preOpenTs,
        sessionOpenTs: fixture.sessionOpenTs,
        squareOffTs: fixture.squareOffTs,
        afterCloseTs: fixture.afterCloseTs,
      },
    ],
    strategies: fixture.strategies,
    indexSymbols: fixture.indexSymbols,
    breadthSymbols: fixture.breadthSymbols,
    ...(fixture.biasConfig === undefined
      ? {}
      : { biasConfig: fixture.biasConfig }),
    allocatedCapital: fixture.allocatedCapital,
    limits: fixture.limits,
  });
}

class ReplayPipeline {
  private readonly fixture: ReplayInput;
  /** The trading day being replayed. */
  private day: ReplaySession;
  /** Realized P&L of the days already closed — the counter resets each open. */
  private realizedOfPastDays = 0;
  private now: number;
  private minutesSinceOpen = 0;
  private readonly hotPrice = new Map<string, number>();
  private readonly candleWindow = new Map<string, Candle[]>();
  private readonly candleCounts = new Map<string, number>();
  private readonly ordersById = new Map<string, Order>();
  private readonly ordersBySignal = new Set<string>();
  private readonly positionsById = new Map<string, Position>();
  /** Latest state of each Trade, in the order Trades were opened. */
  private readonly tradesById = new Map<string, Trade>();

  private readonly signals: SignalRow[] = [];
  private readonly riskDecisions: RiskDecisionRow[] = [];
  private readonly sessionEvents: string[] = [];

  private idSeq = 0;
  private tradeSeq = 0;

  private readonly marketData: MarketDataEngine;
  private readonly session: SessionManager;
  private readonly indicatorEngine: IndicatorEngine;
  private readonly marketBias: MarketBiasEngine;
  private readonly runner: StrategyRunner;
  private readonly exitEngine: ExitEngine;
  private readonly risk: RiskEngine;
  private readonly orderManager: OrderManager;
  private readonly positionEngine: PositionEngine;
  private readonly pnl: PnlEngine;
  private readonly tradeEngine: TradeEngine;

  constructor(fixture: ReplayInput) {
    this.fixture = fixture;
    const first = fixture.sessions[0];
    if (first === undefined)
      throw new Error("a replay needs at least one session");
    this.day = first;
    this.now = first.preOpenTs;

    const onError = (error: unknown): never => {
      // In a golden run any engine error is a bug in the machine, not a
      // tolerable degradation — fail the run loudly.
      throw error instanceof Error ? error : new Error(String(error));
    };
    const publish = this.publish.bind(this);

    // --- Market Data (the feed half) ---
    const marketDataPorts: MarketDataPorts = {
      writeHotSession: () => Promise.resolve(),
      saveCandle: () => Promise.resolve(),
      publish,
    };
    this.marketData = new MarketDataEngine({
      ports: marketDataPorts,
      normalizer: fixtureNormalizer,
      intervals: fixture.intervals,
      onError,
    });
    // ONE session driver, as production now has exactly one. `evaluate()`
    // consumes the open/close edge, so a second instance would swallow the
    // transition the first depends on (see MarketDataEngine's class note).
    this.session = new SessionManager({
      ...NSE_DEFAULT_SESSION,
      specialSessions: fixture.specialSessions ?? [],
    });

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

    // The outcome projection, keyed and fed as the runtime feeds it.
    this.tradeEngine = new TradeEngine({
      ports: {
        saveTrade: (trade) => {
          this.tradesById.set(trade.tradeId, trade);
          return Promise.resolve();
        },
        loadOpenTrades: () => Promise.resolve([]),
        findTradeByOrderId: () => Promise.resolve(null),
        resolvePositionId: (strategyId, symbol) =>
          this.positionEngine.getPosition(strategyId, symbol)?.positionId ??
          null,
      },
      // Its own counter, so adding Trades does not renumber every signal and
      // order after them — the record stays comparable across this change.
      nextTradeId: () => {
        this.tradeSeq += 1;
        return `trd_${String(this.tradeSeq)}`;
      },
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
      readOrder: (orderId) =>
        Promise.resolve(this.ordersById.get(orderId) ?? null),
      publish,
    };
    this.orderManager = new OrderManager({
      broker,
      ports: orderPorts,
      mode: "paper", // the golden run is a deterministic paper harness
      nextOrderId: () => this.nextId("ord"),
      now: () => this.now,
      onError,
    });

    // --- Market bias (the gate risk reads) ---
    const biasPorts: MarketBiasPorts = {
      readCandleWindow: (symbol, interval, count) =>
        Promise.resolve(this.window(symbol, interval).slice(-count)),
    };
    this.marketBias = new MarketBiasEngine({
      ports: biasPorts,
      indexSymbols: () => this.fixture.indexSymbols,
      breadthSymbols: () => this.fixture.breadthSymbols,
      interval: fixture.interval,
      now: () => this.now,
      ...(fixture.biasConfig === undefined
        ? {}
        : { config: fixture.biasConfig }),
      onError,
    });

    // --- Risk Engine ---
    const riskPorts: RiskPorts = {
      readSession: () => Promise.resolve(this.session.phase(this.now)),
      // The REAL gate, not a neutral stand-in: production blocks entries that
      // disagree with the index + breadth read, and a harness that always sees
      // NEUTRAL would never reproduce a day where that mattered.
      readMarketView: () => this.marketBias.current(),
      // Equity fixture — lot size 1 by definition, no symbol master needed.
      readInstrument: () => null,
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

    // --- Exit Engine ---
    const exitPorts: ExitPorts = {
      readOpenPositions: () => this.positionEngine.getOpenPositions(),
      readSession: () => Promise.resolve<SessionContext>(this.sessionContext()),
      persistSignal: (signal) => {
        this.recordSignal(signal);
        return Promise.resolve();
      },
      // Phase 3, wired as the runtime wires it. The durable in-flight check
      // reads this run's own orders (D3)…
      hasExitInFlight: (positionId) =>
        Promise.resolve(
          [...this.ordersById.values()].some(
            (o) =>
              o.positionId === positionId &&
              (o.status === "PLACED" || o.status === "PENDING"),
          ),
        ),
      // …exit rules come from the running instances, as in production…
      readExitRules: (strategyId) => this.runner.exitRulesFor(strategyId),
      // …and a trail moves the live position and its stored copy (D4).
      updateStopLoss: (positionId, stopLoss) => {
        this.positionEngine.setStopLoss(positionId, stopLoss);
        const stored = this.positionsById.get(positionId);
        if (stored !== undefined)
          this.positionsById.set(positionId, { ...stored, stopLoss });
        return Promise.resolve();
      },
    };
    this.exitEngine = new ExitEngine({
      ports: exitPorts,
      handoff: (signal) => this.handoff(signal),
      nextSignalId: () => this.nextId("sig"),
      onError,
    });

    // --- Strategy Runner ---
    const strategyPorts: StrategyPorts = {
      readSession: () => Promise.resolve<SessionContext>(this.sessionContext()),
      readCandleWindow: (symbol, interval, count) =>
        Promise.resolve(this.window(symbol, interval).slice(-count)),
      readPosition: (strategyId, symbol) =>
        Promise.resolve(this.positionEngine.getPosition(strategyId, symbol)),
      // The fixture trades cash equity, so no strategy declares a derivative
      // target and neither of these is ever reached.
      resolveContract: () => null,
      readPrice: () => null,
      readSentiment: () => Promise.resolve(0),
      persistSignal: (signal) => {
        this.recordSignal(signal);
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
      handoff: async (signal) => {
        await this.handoff(signal);
      },
      nextSignalId: () => this.nextId("sig"),
      onError,
    });
  }

  async run(): Promise<GoldenRecord> {
    for (const config of this.fixture.strategies) {
      await this.runner.enable(config);
    }

    for (const day of this.fixture.sessions) {
      this.day = day;
      // Boot before the bell, so the open is a real transition rather than
      // the first thing the session manager ever saw.
      await this.driveSession(day.preOpenTs);

      await this.feedDay(day);

      // The day's end, driven by the same session manager on the same clock:
      // square off while risk will still approve exits, then flush the bars
      // the aggregator is still holding open, then announce the close.
      await this.driveSession(day.squareOffTs);
      await this.driveSession(day.afterCloseTs);
      this.realizedOfPastDays += this.positionEngine.realizedPnl();
    }

    const view = this.marketBias.current();
    return {
      candles: [...this.candleCounts.entries()]
        .map(([key, count]) => {
          const [symbol = "", interval = ""] = key.split("|");
          return { symbol, interval, count };
        })
        .sort((a, b) =>
          `${a.symbol}|${a.interval}`.localeCompare(
            `${b.symbol}|${b.interval}`,
          ),
        ),
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
        ...(p.stopLoss === undefined ? {} : { stopLoss: round4(p.stopLoss) }),
        ...(p.target === undefined ? {} : { target: round4(p.target) }),
      })),
      trades: [...this.tradesById.values()].map((t) => ({
        tradeId: t.tradeId,
        strategyId: t.strategyId,
        ...(t.strategyVersion === undefined
          ? {}
          : { strategyVersion: t.strategyVersion }),
        symbol: t.symbol,
        side: t.side,
        status: t.status,
        entryOrderId: t.entryOrderId,
        ...(t.exitOrderId === undefined ? {} : { exitOrderId: t.exitOrderId }),
        entryPrice: round4(t.entryPrice),
        ...(t.exitPrice === undefined
          ? {}
          : { exitPrice: round4(t.exitPrice) }),
        quantity: t.quantity,
        ...(t.exitReason === undefined ? {} : { exitReason: t.exitReason }),
        grossPnl: round4(t.grossPnl ?? 0),
        charges: round4(t.charges),
        netPnl: round4(t.netPnl ?? 0),
        ...(t.dataProvenance === undefined
          ? {}
          : { entrySource: t.dataProvenance.source }),
      })),
      sessionEvents: this.sessionEvents,
      marketView: { bias: view.bias, detail: view.detail },
      openAtEnd: this.positionEngine.getOpenPositions().length,
      // Every day's, not the last day's: the Position Engine's counter is the
      // risk gate's daily figure and resets at each open.
      realizedPnl: round4(this.realizedOfPastDays),
    };
  }

  /** Feed one day's input, in time order, through the door it arrives by. */
  private async feedDay(day: ReplaySession): Promise<void> {
    const within = (ts: number): boolean =>
      ts >= day.preOpenTs && ts < day.afterCloseTs;
    const source = this.fixture.source;
    if (source.kind === "ticks") {
      for (const tick of source.ticks) {
        if (within(tick.ts)) await this.feedTick(tick);
      }
      return;
    }
    for (const candle of source.candles) {
      const closeTs = candle.ts + intervalMs(candle.interval);
      if (!within(closeTs)) continue;
      // A stored bar arrives when it closes — never before (D7).
      await this.driveSession(closeTs);
      await this.publish("CANDLE_CLOSED", candle);
    }
  }

  /**
   * One raw message, through the same door production uses.
   *
   * The session is evaluated before the tick is ingested, so a bar that closes
   * after the bell is still judged against the phase that was in force — the
   * same ordering the runtime's timer produces.
   */
  private async feedTick(tick: RawTick): Promise<void> {
    await this.driveSession(tick.ts);
    await this.marketData.ingestRaw(tick);
  }

  /**
   * The single session driver (plan/17 §6).
   *
   * Production has exactly one, for a reason recorded in the Market Data
   * Engine: `evaluate()` consumes the open/close edge, so two callers sharing a
   * manager means one of them silently never sees a transition. The harness
   * therefore drives it here and nowhere else.
   */
  private async driveSession(now: number): Promise<void> {
    if (now < this.now) return;
    this.now = now;
    this.minutesSinceOpen = Math.round((now - this.day.sessionOpenTs) / 60_000);
    const evaluation = this.session.evaluate(now);

    if (evaluation.marketOpened) {
      this.indicatorEngine.onMarketOpen();
      this.positionEngine.resetDaily();
      this.sessionEvents.push("MARKET_OPEN");
    }
    // Flatten before the close, while the session is still open enough for
    // risk to approve the exits. By MARKET_CLOSE it is too late — the Risk
    // Engine's session check would block every exit order.
    if (evaluation.phase === "open") {
      await this.exitEngine.onSessionTick(now, this.day.squareOffTs);
    }
    if (evaluation.marketClosed) {
      // Before anyone hears the market shut: the aggregator holds each
      // interval's final bucket open until a later tick pushes it forward, and
      // after the close no such tick arrives.
      await this.marketData.flushOpenBars();
      this.sessionEvents.push("MARKET_CLOSE");
      await this.pnl.snapshot(istDateKey(now));
    }
  }

  /**
   * A closed bar, routed exactly as the runtime routes it.
   *
   * The order is load-bearing and is production's: protective exits are judged
   * before new decisions, so a bar that both hits a stop and sets up an entry
   * closes the position first; and the market view is refreshed before
   * strategies decide, so the gate they are checked against reflects the bar
   * they are deciding on.
   */
  private async onCandleClosed(candle: Candle): Promise<void> {
    this.fixture.onCandleClosed?.(candle);
    this.hotPrice.set(candle.symbol, candle.close);
    this.appendWindow(candle);

    this.runner.onCandleClosed(candle); // cache the bar for the indicator update
    await this.exitEngine.onCandleClosed(candle);
    await this.marketBias.refresh();
    await this.indicatorEngine.onCandleClosed(candle); // → INDICATORS_UPDATED
  }

  private appendWindow(candle: Candle): void {
    const key = `${candle.symbol}|${candle.interval}`;
    const window = this.candleWindow.get(key) ?? [];
    window.push(candle);
    this.candleWindow.set(key, window);
    this.candleCounts.set(key, (this.candleCounts.get(key) ?? 0) + 1);
  }

  private window(symbol: string, interval: CandleInterval): Candle[] {
    return this.candleWindow.get(`${symbol}|${interval}`) ?? [];
  }

  /**
   * The synchronous risk→order handoff (plan/14 §2), saying whether an order
   * came of it — as the runtime's exit handoff does since Phase 3 (audit A7),
   * so a blocked exit is retried here exactly as it is in production.
   */
  private async handoff(signal: Signal): Promise<ExitHandoffOutcome> {
    const decision = await this.risk.validate(signal);
    if (decision.decision !== "approved") return { placed: false };
    const result = await this.orderManager.place(signal, decision);
    return {
      placed: result.status !== "rejected" && result.status !== "halted",
    };
  }

  private recordSignal(signal: Signal): void {
    this.signals.push({
      signalId: signal.signalId,
      strategyId: signal.strategyId,
      symbol: signal.symbol,
      side: signal.side,
      confidence: round4(signal.confidence),
      reason: signal.reason,
    });
  }

  /** The in-memory event bus: route to the next consumer, as the runtime does. */
  private async publish<N extends EventName>(
    name: N,
    payload: EventPayload<N>,
  ): Promise<void> {
    if (name === "CANDLE_CLOSED") {
      await this.onCandleClosed(payload as EventPayload<"CANDLE_CLOSED">);
      return;
    }
    if (name === "INDICATORS_UPDATED") {
      await this.runner.onIndicatorsUpdated(
        payload as EventPayload<"INDICATORS_UPDATED">,
      );
      return;
    }
    if (name === "ORDER_FILLED") {
      const filled = payload as EventPayload<"ORDER_FILLED">;
      // Position first, then the Trade that reads it, then the strategy —
      // the runtime's order (Phase 2, L5).
      await this.positionEngine.onOrderFilled(filled);
      await this.tradeEngine.onOrderFilled(filled);
      this.runner.onOrderFilled(filled);
      return;
    }
    if (name === "ORDER_PLACED") {
      this.runner.onOrderPlaced(payload as EventPayload<"ORDER_PLACED">);
      return;
    }
    if (name === "ORDER_REJECTED") {
      this.runner.onOrderRejected(payload as EventPayload<"ORDER_REJECTED">);
      return;
    }
    if (name === "RISK_BLOCKED") {
      this.runner.onRiskBlocked(payload as EventPayload<"RISK_BLOCKED">);
      return;
    }
    if (name === "POSITION_UPDATED") {
      await this.pnl.refresh(); // realized changed (plan/13 §5)
      return;
    }
    // MARKET_TICK / SIGNAL_CREATED / PNL_UPDATED: captured via the
    // durable-write ports; nothing to route.
  }

  private sessionContext(): SessionContext {
    return {
      phase: this.session.phase(this.now),
      minutesSinceOpen: this.minutesSinceOpen,
      sessionOpenTs: this.day.sessionOpenTs,
    };
  }

  private nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}_${String(this.idSeq)}`;
  }
}

export type { MarketView };
