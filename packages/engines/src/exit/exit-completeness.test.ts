import { describe, expect, it } from "vitest";
import type {
  Candle,
  ExitReason,
  ExitRules,
  Order,
  Signal,
  StrategyConfig,
  Trade,
} from "@neelkanth/core";
import { ExitReasonSchema } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import { ScriptedFakeBroker } from "@neelkanth/broker";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { ExitEngine } from "./exit-engine.js";
import { OrderManager } from "../order/order-manager.js";
import { PositionEngine } from "../position/position-engine.js";
import { StrategyRunner } from "../strategy/strategy-runner.js";
import { TradeEngine } from "../trade/trade-engine.js";

/**
 * Task 3.8 — Phase 3's "done when" (design §7): every entry eventually
 * produces ENTRY → EXIT → COMPLETED TRADE, no entry is orphaned, and each
 * completed Trade names the reason that actually closed it.
 *
 * Real components, in memory: the Strategy Runner running the real EMA
 * crossover, which enters and leaves by itself; the Exit Engine for every
 * other reason; and the real order path — Order Manager, a broker double,
 * Position Engine, Trade Engine — fed fills in the runtime's order, position
 * first. Risk is an approving handoff: what is under test is that every road
 * out reaches a completed Trade, and risk's exemptions for exits are proven
 * in its own suite. Each strategy trades its own symbol, so one case's bars
 * cannot move another case's position.
 */

const PRICE = 100;
/** One completed Trade per reason the platform can produce. */
const REACHED: readonly ExitReason[] = [
  "STRATEGY_EXIT",
  "STOP_LOSS",
  "TAKE_PROFIT",
  "TIME_EXIT",
  "MANUAL_EMERGENCY",
  "SESSION_CLOSE",
];
const MIN = 60_000;

function pipeline(exitRules: Record<string, ExitRules>) {
  const orders = new Map<string, Order>();
  const trades = new Map<string, Trade>();
  const errors: Record<string, unknown>[] = [];
  const onError = (_error: unknown, context: Record<string, unknown>) => {
    errors.push(context);
  };
  let seq = 0;
  const id = (prefix: string) => {
    seq += 1;
    return `${prefix}_${String(seq)}`;
  };

  const positions = new PositionEngine({
    ports: {
      writePosition: () => Promise.resolve(),
      publish: () => Promise.resolve(),
    },
    nextPositionId: () => id("pos"),
    onError,
  });
  const tradeEngine = new TradeEngine({
    ports: {
      saveTrade: (trade) => {
        trades.set(trade.tradeId, trade);
        return Promise.resolve();
      },
      loadOpenTrades: () => Promise.resolve([]),
      findTradeByOrderId: () => Promise.resolve(null),
      resolvePositionId: (strategyId, symbol) =>
        positions.getPosition(strategyId, symbol)?.positionId ?? null,
    },
    nextTradeId: () => id("trd"),
    onError,
  });

  // The runner is built after the order path it feeds; fills reach it here.
  const late: { runner?: StrategyRunner } = {};
  const manager = new OrderManager({
    broker: new ScriptedFakeBroker({ defaultFillPrice: PRICE }),
    ports: {
      readTradingEnabled: () => Promise.resolve(true),
      persistOrder: (order) => {
        orders.set(order.orderId, order);
        return Promise.resolve(true);
      },
      updateOrder: (orderId, patch) => {
        const existing = orders.get(orderId);
        if (existing !== undefined)
          orders.set(orderId, { ...existing, ...patch });
        return Promise.resolve();
      },
      readOrder: (orderId) => Promise.resolve(orders.get(orderId) ?? null),
      publish: async (name, payload) => {
        if (name !== "ORDER_FILLED") return;
        const fill = payload as EventPayload<"ORDER_FILLED">;
        await positions.onOrderFilled(fill); // position first, as the runtime does
        await tradeEngine.onOrderFilled(fill);
        late.runner?.onOrderFilled(fill);
      },
    },
    mode: "paper",
    nextOrderId: () => id("ord"),
    onError,
  });
  const place = async (signal: Signal) => {
    const result = await manager.place(signal, { decision: "approved" });
    return {
      placed: result.status !== "rejected" && result.status !== "halted",
    };
  };

  const runner = new StrategyRunner({
    registry: createStrategyRegistry(),
    ports: {
      readSession: () =>
        Promise.resolve({
          phase: "open" as const,
          minutesSinceOpen: 30,
          sessionOpenTs: 0,
        }),
      readCandleWindow: () => Promise.resolve([]),
      readPosition: (strategyId, symbol) =>
        Promise.resolve(positions.getPosition(strategyId, symbol)),
      readSentiment: () => Promise.resolve(0),
      resolveContract: () => null,
      readPrice: () => null,
      persistSignal: () => Promise.resolve(),
      publish: () => Promise.resolve(),
    },
    provisionIndicators: () => Promise.resolve(),
    handoff: async (signal) => {
      await place(signal);
    },
    nextSignalId: () => id("sig"),
    onError,
  });

  late.runner = runner;

  const exits = new ExitEngine({
    ports: {
      readOpenPositions: () => positions.getOpenPositions(),
      readSession: () =>
        Promise.resolve({
          phase: "open" as const,
          minutesSinceOpen: 30,
          sessionOpenTs: 0,
        }),
      persistSignal: () => Promise.resolve(),
      hasExitInFlight: (positionId) =>
        Promise.resolve(
          [...orders.values()].some(
            (o) =>
              o.positionId === positionId &&
              (o.status === "PLACED" || o.status === "PENDING"),
          ),
        ),
      readExitRules: (strategyId) => exitRules[strategyId] ?? null,
      updateStopLoss: (positionId, stopLoss) => {
        positions.setStopLoss(positionId, stopLoss);
        return Promise.resolve();
      },
    },
    handoff: place,
    nextSignalId: () => id("sig"),
    onError,
  });

  /** An entry, as a strategy would propose it — with protective levels. */
  const enter = (
    strategyId: string,
    symbol: string,
    levels: { stopLoss: number; target: number },
  ) =>
    place({
      signalId: id("sig"),
      strategyId,
      symbol,
      side: "BUY",
      confidence: 1,
      qtyProposal: 10,
      ...levels,
      reason: "entry",
      contextSnapshot: {
        price: PRICE,
        indicators: {},
        session: "open",
        sentiment: 0,
      },
      ts: Date.now(),
    });

  const bar = (symbol: string, over: Partial<Candle>): Candle => ({
    symbol,
    interval: "5m",
    open: PRICE,
    high: PRICE,
    low: PRICE,
    close: PRICE,
    volume: 1,
    ts: Date.now(),
    source: "LIVE_TICK",
    ...over,
  });

  return {
    runner,
    exits,
    positions,
    tradeEngine,
    trades,
    errors,
    enter,
    bar,
  };
}

describe("every entry reaches a completed Trade (§3.8)", () => {
  it("leaves six closed Trades with six different reasons, and nothing open", async () => {
    const p = pipeline({
      str_time: { maxHoldMinutes: 15 },
    });
    const opened = Date.now();

    // STRATEGY_EXIT — the real EMA crossover enters on a cross up and leaves
    // on the cross down, by itself, through the runner (D1).
    const ema: StrategyConfig = {
      strategyId: "str_ema",
      ownerId: "usr_1",
      type: "EMA_CROSSOVER",
      name: "EMA 9/21",
      params: { quantity: 10 },
      symbols: ["NSE:EMA-EQ"],
      enabled: true,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
    };
    await p.runner.enable(ema);
    const emaBar = async (ts: number, ema9: number, ema21: number) => {
      p.runner.onCandleClosed(p.bar("NSE:EMA-EQ", { ts }));
      await p.runner.onIndicatorsUpdated({
        symbol: "NSE:EMA-EQ",
        interval: "5m",
        indicators: { ema9, ema21 },
        ts,
      });
    };
    await emaBar(opened, 98, 99); // seeds: fast below slow
    await emaBar(opened + 5 * MIN, 101, 99); // crosses up → BUY
    expect(p.positions.getPosition("str_ema", "NSE:EMA-EQ")).not.toBeNull();
    await emaBar(opened + 10 * MIN, 98, 99); // crosses down → exit

    // STOP_LOSS, TAKE_PROFIT, TIME_EXIT — the Exit Engine, on closed bars.
    await p.enter("str_stop", "NSE:STOP-EQ", { stopLoss: 99, target: 120 });
    await p.exits.onCandleClosed(p.bar("NSE:STOP-EQ", { low: 98 }));

    await p.enter("str_target", "NSE:TGT-EQ", { stopLoss: 90, target: 105 });
    await p.exits.onCandleClosed(p.bar("NSE:TGT-EQ", { high: 106 }));

    await p.enter("str_time", "NSE:TIME-EQ", { stopLoss: 90, target: 120 });
    const timeOpened =
      p.positions.getPosition("str_time", "NSE:TIME-EQ")?.openedAt ?? 0;
    // The bar starting 10m in closes 15m in: the limit (D2).
    await p.exits.onCandleClosed(
      p.bar("NSE:TIME-EQ", { ts: timeOpened + 10 * MIN }),
    );

    // MANUAL_EMERGENCY — the operator's exit (D5).
    await p.enter("str_manual", "NSE:MAN-EQ", { stopLoss: 90, target: 120 });
    const manual = p.positions.getPosition("str_manual", "NSE:MAN-EQ");
    expect(await p.exits.exitNow(manual?.positionId ?? "", Date.now())).toBe(
      true,
    );

    // SESSION_CLOSE — last, because it flattens whatever is still open (D6).
    await p.enter("str_session", "NSE:SESS-EQ", { stopLoss: 90, target: 120 });
    await p.exits.onSessionTick(Date.now(), Date.now() - 1);

    expect(p.errors).toEqual([]);

    // No orphaned entries — the phase's own wording.
    expect(p.positions.getOpenPositions()).toEqual([]);
    const all = [...p.trades.values()];
    expect(all.filter((t) => t.status === "OPEN")).toEqual([]);

    expect(all).toHaveLength(REACHED.length);
    expect(all.map((t) => t.exitReason).sort()).toEqual([...REACHED].sort());

    // Each is complete, not merely closed: both orders, its position.
    for (const trade of all) {
      expect(trade.entryOrderId).toBeDefined();
      expect(trade.exitOrderId).toBeDefined();
      expect(trade.exitOrderId).not.toBe(trade.entryOrderId);
      expect(trade.orderIds).toHaveLength(2);
      expect(trade.positionId).toMatch(/^pos_/);
      expect(trade.openQuantity).toBe(0);
    }
  });

  /**
   * The test above covers every reason in the schema but one. This ties it to
   * `ExitReasonSchema` itself, so a reason added later without a producer —
   * a label nothing can ever write — fails here rather than going unnoticed.
   * BROKER_RECONCILIATION is the deliberate exception: it describes a position
   * that went away without being asked to, which belongs with reconciliation.
   */
  it("covers every exit reason but BROKER_RECONCILIATION", () => {
    expect(
      ExitReasonSchema.options.filter((r) => r !== "BROKER_RECONCILIATION"),
    ).toEqual(expect.arrayContaining([...REACHED]));
    expect(ExitReasonSchema.options).toHaveLength(REACHED.length + 1);
  });
});
