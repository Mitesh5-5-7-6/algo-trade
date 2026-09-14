import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Candle,
  CandleSource,
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
      source: "LIVE_TICK",
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

describe("CandlesRepository provenance precedence (design D3)", () => {
  const SYM = "NSE:PREC-EQ";
  const bar = (
    ts: number,
    close: number,
    source: CandleSource = "LIVE_TICK",
  ): Candle => ({
    symbol: SYM,
    interval: "5m",
    source,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
    ts,
  });

  /**
   * The invariant: one (symbol, interval, ts) is ONE canonical candle, whatever
   * produced it. Provenance says where a bar came from; it never creates a
   * second bar. Without precedence, whether the broker's record or our
   * tick aggregation survives would depend on which job happened to run last.
   */
  it("lets the broker's record overwrite a live-aggregated bar", async () => {
    const repo = new CandlesRepository(connection.db);
    expect(await repo.upsert(bar(1000, 10, "LIVE_TICK"))).toBe(true);
    expect(await repo.upsert(bar(1000, 99, "BROKER_HISTORICAL"))).toBe(true);

    const stored = await repo.findRange(SYM, "5m", 0, 2000);
    expect(stored).toHaveLength(1); // one bar, not two
    expect(stored[0]?.close).toBe(99);
    expect(stored[0]?.source).toBe("BROKER_HISTORICAL");
  });

  it("refuses to let a live bar demote the broker's record", async () => {
    const repo = new CandlesRepository(connection.db);
    expect(await repo.upsert(bar(3000, 99, "BROKER_HISTORICAL"))).toBe(true);
    expect(await repo.upsert(bar(3000, 10, "LIVE_TICK"))).toBe(false);

    const stored = await repo.findRange(SYM, "5m", 3000, 4000);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.close).toBe(99); // the better record survived
    expect(stored[0]?.source).toBe("BROKER_HISTORICAL");
  });

  it("allows an equal-ranked rewrite, so a re-run is a no-op not a refusal", async () => {
    const repo = new CandlesRepository(connection.db);
    await repo.upsert(bar(5000, 50, "BROKER_HISTORICAL"));
    // Re-running a completed backfill must report as applied, not refused.
    expect(await repo.upsert(bar(5000, 50, "BROKER_HISTORICAL"))).toBe(true);
    expect(await repo.upsert(bar(5000, 51, "BROKER_HISTORICAL"))).toBe(true);
    const stored = await repo.findRange(SYM, "5m", 5000, 6000);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.close).toBe(51);
  });

  /**
   * Bars written before provenance existed carry no `sourceRank`, and in Mongo
   * a missing field does not match `$lte`. Treated naively they would fail the
   * predicate, fall through to an insert, and collide with the unique index.
   */
  it("treats a legacy bar with no provenance as LIVE_TICK, not as absent", async () => {
    const repo = new CandlesRepository(connection.db);
    await connection.db.collection(COLLECTIONS.candles).insertOne({
      symbol: SYM,
      interval: "5m",
      open: 7,
      high: 7,
      low: 7,
      close: 7,
      volume: 1,
      ts: 7000,
    });

    // Readable, and defaulted rather than throwing.
    const before = await repo.findRange(SYM, "5m", 7000, 8000);
    expect(before[0]?.source).toBe("LIVE_TICK");

    // Upgradable in place — one document, not a duplicate-key explosion.
    expect(await repo.upsert(bar(7000, 77, "BROKER_HISTORICAL"))).toBe(true);
    const after = await repo.findRange(SYM, "5m", 7000, 8000);
    expect(after).toHaveLength(1);
    expect(after[0]?.close).toBe(77);
  });
});

describe("CandlesRepository.findRange (design D4)", () => {
  const SYM = "NSE:RANGE-EQ";
  const bar = (ts: number): Candle => ({
    symbol: SYM,
    interval: "5m",
    source: "BROKER_HISTORICAL",
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    ts,
  });

  /**
   * Half-open [from, to) on purpose: consecutive day requests tile exactly,
   * with no bar counted twice at a boundary and none skipped.
   */
  it("includes the lower bound and excludes the upper, oldest first", async () => {
    const repo = new CandlesRepository(connection.db);
    for (const ts of [1000, 2000, 3000, 4000]) await repo.upsert(bar(ts));

    const range = await repo.findRange(SYM, "5m", 2000, 4000);
    expect(range.map((c) => c.ts)).toEqual([2000, 3000]);
  });

  it("tiles without overlap or gap across adjacent ranges", async () => {
    const repo = new CandlesRepository(connection.db);
    for (const ts of [1000, 2000, 3000, 4000]) await repo.upsert(bar(ts));

    const first = await repo.findRange(SYM, "5m", 1000, 3000);
    const second = await repo.findRange(SYM, "5m", 3000, 5000);
    expect([...first, ...second].map((c) => c.ts)).toEqual([
      1000, 2000, 3000, 4000,
    ]);
  });

  it("returns nothing for an empty or inverted range", async () => {
    const repo = new CandlesRepository(connection.db);
    await repo.upsert(bar(1000));
    expect(await repo.findRange(SYM, "5m", 9000, 9999)).toEqual([]);
    expect(await repo.findRange(SYM, "5m", 5000, 5000)).toEqual([]);
    expect(await repo.findRange(SYM, "5m", 5000, 1000)).toEqual([]);
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

describe("day-stats aggregations (plan/06 §4 read model)", () => {
  // A boundary above every other timestamp in this shared-db file, so these
  // aggregations see only their own seeds.
  const DAY = 1_800_000_000_000;

  const position = (overrides: Partial<Position>): Position => ({
    positionId: "pos_agg",
    symbol: "NSE:X-EQ",
    strategyId: "str_agg_a",
    side: "LONG",
    qty: 0,
    avgEntryPrice: 100,
    status: "CLOSED",
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: DAY + 1,
    mode: "paper",
    ...overrides,
  });

  const signal = (overrides: Partial<Signal>): Signal => ({
    signalId: "sig_agg",
    strategyId: "str_agg_a",
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
    ts: DAY + 1,
    ...overrides,
  });

  it("sums realized PnL per strategy for positions opened since the boundary", async () => {
    const repo = new PositionsRepository(connection.db);
    await repo.upsert(
      position({
        positionId: "pa1",
        strategyId: "str_agg_a",
        realizedPnl: 150,
      }),
    );
    await repo.upsert(
      position({
        positionId: "pa2",
        strategyId: "str_agg_a",
        realizedPnl: -40,
      }),
    );
    await repo.upsert(
      position({ positionId: "pb1", strategyId: "str_agg_b", realizedPnl: 75 }),
    );
    // Opened before the boundary — yesterday's position, excluded.
    await repo.upsert(
      position({
        positionId: "pold",
        strategyId: "str_agg_a",
        realizedPnl: 999,
        openedAt: DAY - 1,
      }),
    );

    const sums = await repo.sumRealizedByStrategySince(DAY);
    expect(sums.get("str_agg_a")).toBe(110);
    expect(sums.get("str_agg_b")).toBe(75);
    expect(sums.has("str_old")).toBe(false);
  });

  it("counts actionable signals per strategy, excluding HOLD and older rows", async () => {
    const repo = new SignalsRepository(connection.db);
    await repo.insert(signal({ signalId: "sa1", side: "BUY" }));
    await repo.insert(signal({ signalId: "sa2", side: "SELL", ts: DAY + 2 }));
    await repo.insert(signal({ signalId: "sa3", side: "HOLD", ts: DAY + 3 }));
    await repo.insert(
      signal({ signalId: "sb1", strategyId: "str_agg_b", ts: DAY + 4 }),
    );
    await repo.insert(signal({ signalId: "sold", ts: DAY - 5 })); // yesterday

    const counts = await repo.countActionableByStrategySince(DAY);
    expect(counts.get("str_agg_a")).toBe(2); // BUY + SELL, HOLD dropped
    expect(counts.get("str_agg_b")).toBe(1);
  });
});
