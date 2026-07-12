import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Candle,
  Order,
  PnlSnapshot,
  Position,
  RiskLog,
  Signal,
  StrategyConfig,
} from "@neelkanth/core";
import {
  CandlesRepository,
  COLLECTIONS,
  connectMongo,
  ensureIndexes,
  OrdersRepository,
  PnlSnapshotsRepository,
  PositionsRepository,
  RiskLogsRepository,
  SignalsRepository,
  StrategiesRepository,
  type MongoConnection,
} from "./index.js";

/** Integration tests against REAL MongoDB (plan/27 §2). */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/neelkanth_repos_test";

let connection: MongoConnection;

beforeAll(async () => {
  // A per-file database so parallel integration test files never share one.
  connection = await connectMongo(MONGO_URI, "neelkanth_it_repos");
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
});

afterAll(async () => {
  await connection.close();
});

const order = (overrides: Partial<Order> = {}): Order => ({
  orderId: "ord_1",
  signalId: "sig_1",
  strategyId: "str_1",
  symbol: "NSE:X-EQ",
  side: "BUY",
  qty: 10,
  type: "MARKET",
  status: "PLACED",
  mode: "paper",
  createdAt: 1000,
  ...overrides,
});

describe("OrdersRepository (plan/12 §6)", () => {
  it("inserts, rejects a duplicate signalId, updates, and queries by status", async () => {
    const repo = new OrdersRepository(connection.db);
    expect(await repo.insert(order({ orderId: "o1", signalId: "s1" }))).toBe(
      true,
    );
    // Same signalId, different orderId → the unique backstop rejects it.
    expect(await repo.insert(order({ orderId: "o2", signalId: "s1" }))).toBe(
      false,
    );

    await repo.update("o1", { status: "FILLED", filledPrice: 100, charges: 5 });
    expect((await repo.findByOrderId("o1"))?.status).toBe("FILLED");

    await repo.insert(
      order({ orderId: "o3", signalId: "s3", status: "PLACED" }),
    );
    const placed = await repo.findByStatus(["PLACED", "PENDING"]);
    expect(placed.map((o) => o.orderId)).toEqual(["o3"]);
  });
});

describe("PositionsRepository (plan/13 §8)", () => {
  it("upserts by positionId and finds only open positions", async () => {
    const repo = new PositionsRepository(connection.db);
    const base: Position = {
      positionId: "pos_1",
      symbol: "NSE:X-EQ",
      strategyId: "str_1",
      side: "LONG",
      qty: 10,
      avgEntryPrice: 100,
      status: "OPEN",
      realizedPnl: 0,
      unrealizedPnl: 0,
      openedAt: 1,
      mode: "paper",
    };
    await repo.upsert(base);
    await repo.upsert({ ...base, qty: 20 }); // same id → update, not duplicate
    await repo.upsert({
      ...base,
      positionId: "pos_2",
      status: "CLOSED",
      qty: 0,
    });

    const open = await repo.findOpen();
    expect(open).toHaveLength(1);
    expect(open[0]?.qty).toBe(20);
  });
});

describe("SignalsRepository (plan/07 §4 split retention)", () => {
  const signal = (overrides: Partial<Signal> = {}): Signal => ({
    signalId: "sig_1",
    strategyId: "str_1",
    symbol: "NSE:X-EQ",
    side: "BUY",
    confidence: 0.8,
    reason: "test",
    contextSnapshot: {
      price: 100,
      indicators: {},
      session: "open",
      sentiment: 0,
    },
    ts: 1_700_000_000_000,
    ...overrides,
  });

  it("stamps expireAt on HOLD rows but not on BUY/SELL", async () => {
    const repo = new SignalsRepository(connection.db);
    await repo.insert(signal({ signalId: "buy_1", side: "BUY" }));
    await repo.insert(signal({ signalId: "hold_1", side: "HOLD" }));

    const raw = connection.db.collection(COLLECTIONS.signals);
    const buy = await raw.findOne({ signalId: "buy_1" });
    const hold = await raw.findOne({ signalId: "hold_1" });
    expect(buy?.["expireAt"]).toBeUndefined();
    expect(hold?.["expireAt"]).toBeInstanceOf(Date);
  });

  it("reads recent signals for a strategy newest-first", async () => {
    const repo = new SignalsRepository(connection.db);
    await repo.insert(signal({ signalId: "a", strategyId: "sX", ts: 1 }));
    await repo.insert(signal({ signalId: "b", strategyId: "sX", ts: 2 }));
    const recent = await repo.findRecentByStrategy("sX", 10);
    expect(recent.map((s) => s.signalId)).toEqual(["b", "a"]);
  });
});

describe("RiskLogsRepository (plan/14 §7)", () => {
  it("appends decisions and filters blocks", async () => {
    const repo = new RiskLogsRepository(connection.db);
    const log = (overrides: Partial<RiskLog>): RiskLog => ({
      signalId: "sig_1",
      strategyId: "str_1",
      symbol: "NSE:X-EQ",
      decision: "approved",
      checks: [],
      ts: 1,
      ...overrides,
    });
    await repo.insert(log({ ts: 1, decision: "approved" }));
    await repo.insert(
      log({
        ts: 2,
        decision: "blocked",
        failedCheck: "dailyLoss",
        reason: "x",
      }),
    );
    const blocked = await repo.findRecent(10, true);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.failedCheck).toBe("dailyLoss");
  });
});

describe("PnlSnapshotsRepository (plan/13 §6)", () => {
  it("upserts idempotently by (scope, date)", async () => {
    const repo = new PnlSnapshotsRepository(connection.db);
    const snap = (overrides: Partial<PnlSnapshot>): PnlSnapshot => ({
      scope: "global",
      date: "2026-01-05",
      realizedPnl: 100,
      unrealizedPnl: 0,
      equity: 100,
      tradeCount: 1,
      ts: 1,
      ...overrides,
    });
    await repo.upsert(snap({ realizedPnl: 100 }));
    await repo.upsert(snap({ realizedPnl: 250 })); // same scope+date → overwrite
    const curve = await repo.findByScope("global", 10);
    expect(curve).toHaveLength(1);
    expect(curve[0]?.realizedPnl).toBe(250);
  });
});

describe("CandlesRepository (plan/18 §4)", () => {
  it("upserts by (symbol,interval,ts) and loads recent bars oldest-first", async () => {
    const repo = new CandlesRepository(connection.db);
    const candle = (ts: number, close: number): Candle => ({
      symbol: "NSE:C-EQ",
      interval: "5m",
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
      ts,
    });
    await repo.upsert(candle(1000, 10));
    await repo.upsert(candle(1000, 11)); // same key → update
    await repo.upsert(candle(2000, 12));
    const recent = await repo.loadRecent("NSE:C-EQ", "5m", 10);
    expect(recent.map((c) => c.close)).toEqual([11, 12]); // oldest→newest
  });
});

describe("StrategiesRepository (plan/07, plan/15 §8)", () => {
  const config = (overrides: Partial<StrategyConfig> = {}): StrategyConfig => ({
    strategyId: "str_1",
    ownerId: "usr_1",
    type: "EMA_CROSSOVER",
    name: "EMA",
    params: { fast: 9, slow: 21 },
    symbols: ["NSE:X-EQ"],
    enabled: false,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  it("creates, enables, lists enabled, and soft-deletes", async () => {
    const repo = new StrategiesRepository(connection.db);
    await repo.create(config({ strategyId: "a", ownerId: "u1" }));
    await repo.create(config({ strategyId: "b", ownerId: "u1" }));

    await repo.setEnabled("a", true);
    expect((await repo.findEnabled()).map((s) => s.strategyId)).toEqual(["a"]);

    await repo.softDelete("a");
    expect(await repo.findEnabled()).toHaveLength(0); // disabled by soft-delete
    expect((await repo.listByOwner("u1")).map((s) => s.strategyId)).toEqual([
      "b",
    ]); // deleted excluded
  });

  it("returns null updating an unknown strategy", async () => {
    const repo = new StrategiesRepository(connection.db);
    expect(await repo.update("ghost", { name: "x" })).toBeNull();
  });
});
