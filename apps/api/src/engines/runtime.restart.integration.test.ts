import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createLogger } from "@neelkanth/logger";
import { PaperBroker, ScriptedFakeBroker } from "@neelkanth/broker";
import {
  connectMongo,
  ensureIndexes,
  PaperBrokerOrdersRepository,
  RiskEventsRepository,
  SettingsRepository,
  type MongoConnection,
} from "@neelkanth/db";
import {
  createRedisConnections,
  riskDailyLossKey,
  type RedisConnections,
} from "@neelkanth/redis";
import { istDateKey } from "@neelkanth/core";
import { startEngineRuntime, type EngineRuntime } from "./runtime.js";
import { createLiveMarketState } from "./live-market-state.js";
import { STRICT } from "../test-support/infra.js";

/**
 * The day's realized loss across a real process restart (§0.8).
 *
 * §0.5.4's unit tests are good — two `DailyLossLedger` instances over one fake
 * store and a real `PositionEngine` — but they leave four things untouched, and
 * all four sit between the ledger and the outcome the acceptance criterion
 * claims:
 *
 * 1. the **Redis adapter** defined inline in `runtime.ts` — `Number(raw)`, the
 *    non-finite guard, the TTL. A typo in the key builder or a TTL shorter than
 *    a trading day would pass every existing test.
 * 2. the **write side** — `dailyLoss.persist` in the POSITION_UPDATED handler
 *    is what makes the counter exist at all.
 * 3. the **boot sequence** — `hydrate` then `seedDailyRealized`, deliberately
 *    outside the optional warm-up block so an unreadable ledger refuses the
 *    boot rather than trading blind.
 * 4. that a **second process** actually reads back what the first wrote.
 *
 * There is no cheaper honest version of this test. An in-memory port double
 * reproduces exactly the unit test that already exists and proves nothing new,
 * which is why this one needs real Redis and real Mongo.
 */

const IT_DB = "neelkanth_it_restart";

/** Point a Mongo URI at this suite's isolated database, whatever it named. */
function isolate(uri: string, dbName: string): string {
  const queryAt = uri.indexOf("?");
  const base = queryAt === -1 ? uri : uri.slice(0, queryAt);
  const query = queryAt === -1 ? "" : uri.slice(queryAt);
  const schemeEnd = base.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = base.indexOf("/", authorityStart);
  const authority = pathStart === -1 ? base : base.slice(0, pathStart);
  return `${authority}/${dbName}${query}`;
}

const MONGO_URI = isolate(
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder",
  IT_DB,
);
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

/**
 * Each restart test boots TWO complete runtimes, and every boot opens Mongo
 * and Redis connections, hydrates positions and reconciles orders. Against
 * hosted instances across a region that does not fit in vitest's 5s default,
 * and the failure looked exactly like a wrong answer rather than a slow one.
 */
const RESTART_TIMEOUT_MS = 60_000;

const SYMBOL = "NSE:RESTART-EQ";
const STRATEGY = "str_restart";

let mongo: MongoConnection | undefined;
let redis: RedisConnections | undefined;
let reachable = false;

function silentLogger() {
  return createLogger({
    level: "fatal",
    name: "test",
    destination: {
      write() {
        return true;
      },
    },
  });
}

/** A runtime wired to the same real Redis and Mongo every time. */
async function boot(
  broker: ScriptedFakeBroker | PaperBroker = new ScriptedFakeBroker(),
): Promise<EngineRuntime> {
  if (mongo === undefined || redis === undefined) {
    throw new Error("infrastructure not probed");
  }
  return startEngineRuntime({
    redis,
    mongo,
    logger: silentLogger(),
    broker,
    ...(broker instanceof PaperBroker ? { paperOrderMonitor: broker } : {}),
    mode: "paper",
    liveState: createLiveMarketState(),
  });
}

/**
 * Drive one round trip through the bus: buy at `entry`, sell at `exit`.
 *
 * Published as ORDER_FILLED rather than routed through risk, because what is
 * under test is the projection and its durability, not the entry decision.
 */
async function roundTrip(
  runtime: EngineRuntime,
  entry: number,
  exit: number,
  qty: number,
): Promise<void> {
  const base = {
    strategyId: STRATEGY,
    symbol: SYMBOL,
    qty,
    slippage: 0,
    charges: 0,
    mode: "paper" as const,
  };
  await runtime.bus.publish("ORDER_FILLED", {
    ...base,
    orderId: "ord_restart_in",
    side: "BUY",
    filledPrice: entry,
    filledAt: 1,
    ts: 1,
  });
  await runtime.bus.publish("ORDER_FILLED", {
    ...base,
    orderId: "ord_restart_out",
    side: "SELL",
    filledPrice: exit,
    filledAt: 2,
    ts: 2,
  });
  // The fill → position → PnL → ledger chain crosses the bus and Mongo, so
  // wait for its OUTCOME rather than a fixed time. Fills are projected one at
  // a time since §2.7, each waiting on the last one's writes; against hosted
  // Mongo a fixed 300ms ended before the exit fill was processed, and the
  // test read a realized P&L of zero.
  const realized = (exit - entry) * qty;
  await vi.waitFor(
    async () => {
      expect(runtime.realizedPnl()).toBeCloseTo(realized, 4);
      const raw = await redis?.client.get(
        riskDailyLossKey(istDateKey(Date.now())),
      );
      expect(Number(raw)).toBeCloseTo(realized, 4);
    },
    { timeout: 20_000, interval: 50 },
  );
}

beforeAll(async () => {
  let mongoOk = false;
  try {
    mongo = await connectMongo(MONGO_URI, IT_DB);
    if (!/^neelkanth_(it|ci)_/.test(mongo.db.databaseName)) {
      throw new Error(
        `refusing to drop database "${mongo.db.databaseName}" — integration ` +
          "suites may only target neelkanth_it_* or neelkanth_ci_*",
      );
    }
    await mongo.db.dropDatabase();
    await ensureIndexes(mongo.db);
    mongoOk = true;
  } catch {
    mongoOk = false;
  }

  let redisOk = false;
  try {
    redis = createRedisConnections(REDIS_URL, () => undefined);
    await redis.client.ping();
    redisOk = true;
  } catch {
    redisOk = false;
  }

  reachable = mongoOk && redisOk;
  if (reachable) return;

  const missing = [mongoOk ? null : "MongoDB", redisOk ? null : "Redis"]
    .filter((name) => name !== null)
    .join(" and ");
  if (STRICT) {
    throw new Error(
      `runtime.restart.integration.test.ts: ${missing} unreachable and ` +
        "REQUIRE_INTEGRATION=1",
    );
  }
  const line = "#".repeat(74);
  process.stderr.write(
    `\n${line}\n` +
      `INTEGRATION SUITE NOT RUN — apps/api/src/engines/runtime.restart.integration.test.ts\n` +
      `  These tests were NOT EXECUTED. Skipped is not passed.\n` +
      `  reason : ${missing} unreachable\n` +
      `  target : database "${IT_DB}", ${REDIS_URL}\n` +
      `  fix    : docker compose -f docker-compose.test.yml up -d\n` +
      `  strict : run \`pnpm test:integration\` to make this a hard failure\n` +
      `${line}\n\n`,
  );
});

afterAll(async () => {
  await mongo?.close();
  await redis?.quit();
});

/**
 * Reset the two pieces of state a restart is supposed to carry.
 *
 * Both outlive a test by design — that is the whole point of the feature — so
 * without this each test inherits the previous one's position history and the
 * previous one's ledger entry, and asserts against an accumulated figure. The
 * first version of this file did exactly that and reported a "profitable day"
 * as −51.27: four round trips summed, not the one the test performed.
 *
 * Deleting the ledger key is what makes each test a genuine first boot of the
 * day, which is the state the restart claim is actually about.
 */
beforeEach(async (ctx) => {
  if (!reachable) {
    ctx.skip();
    return;
  }
  await redis?.client.del(riskDailyLossKey(istDateKey(Date.now())));
  await mongo?.db.collection("positions").deleteMany({});
  await mongo?.db.collection("trades").deleteMany({});
  await mongo?.db.collection("orders").deleteMany({});
  await mongo?.db.collection("paper_broker_orders").deleteMany({});
  await mongo?.db.collection("risk_events").deleteMany({});
  await mongo?.db.collection("paper_reconciliations").deleteMany({});
  if (mongo !== undefined) {
    await new SettingsRepository(mongo.db).setTradingEnabled(true);
  }
});

describe("the day's risk state survives a restart (§0.8)", () => {
  /**
   * The failing scenario, end to end: lose money in the morning, crash, come
   * back. Before §0.5.4 the second process saw a flat day and would have
   * allowed the afternoon to lose the same amount again against one limit.
   */
  it(
    "restores the morning's realized loss into a second process",
    async () => {
      const first = await boot();
      try {
        await roundTrip(first, 100, 90, 10); // −100 realized
        expect(first.realizedPnl()).toBeCloseTo(-100, 4);
      } finally {
        await first.shutdown();
      }

      const second = await boot();
      try {
        expect(second.realizedPnl()).toBeCloseTo(-100, 4);
      } finally {
        await second.shutdown();
      }
    },
    RESTART_TIMEOUT_MS,
  );

  /**
   * The adapter itself: the key builder, the serialization, and the fact that
   * something writes at all. Asserted against the real key so a typo in
   * `riskDailyLossKey` cannot pass.
   */
  it(
    "writes the counter to the key the namespace table reserved",
    async () => {
      const runtime = await boot();
      try {
        await roundTrip(runtime, 200, 150, 4); // −200 realized
        const raw = await redis?.client.get(
          riskDailyLossKey(istDateKey(Date.now())),
        );
        expect(raw).not.toBeNull();
        expect(Number(raw)).toBeCloseTo(runtime.realizedPnl(), 4);
      } finally {
        await runtime.shutdown();
      }
    },
    RESTART_TIMEOUT_MS,
  );

  /**
   * The counter must outlive an overnight restart, so a TTL shorter than a
   * trading day would silently reintroduce the bug on the next morning's boot.
   */
  it(
    "keeps the counter alive well beyond one trading day",
    async () => {
      const runtime = await boot();
      try {
        await roundTrip(runtime, 100, 95, 2);
        const ttl = await redis?.client.ttl(
          riskDailyLossKey(istDateKey(Date.now())),
        );
        expect(ttl).toBeGreaterThan(86_400);
      } finally {
        await runtime.shutdown();
      }
    },
    RESTART_TIMEOUT_MS,
  );

  /**
   * A profitable day is not a loss. `lossFrom` clamps at zero, and the gate
   * compares a positive number against a positive limit — a negative loss
   * would make the comparison meaningless rather than merely wrong.
   */
  it(
    "restores a profitable day as a profit, not a negative loss",
    async () => {
      const first = await boot();
      try {
        await roundTrip(first, 100, 120, 5); // +100 realized
        expect(first.realizedPnl()).toBeCloseTo(100, 4);
      } finally {
        await first.shutdown();
      }

      const second = await boot();
      try {
        expect(second.realizedPnl()).toBeCloseTo(100, 4);
      } finally {
        await second.shutdown();
      }
    },
    RESTART_TIMEOUT_MS,
  );
});

/**
 * Task 2.7 — the RUNTIME records the trade, not just the engine in a harness.
 *
 * Every other trade test builds a `TradeEngine` itself. None proves that
 * `startEngineRuntime` constructs one, subscribes it to `ORDER_FILLED` AFTER
 * the Position Engine (or `positionId` resolves to nothing), saves through the
 * real repository, and hydrates it on boot. A wiring slip there — a missing
 * subscription — would pass every one of them while no trade was ever written.
 */
describe("the runtime records exactly one trade per round trip (§2.7)", () => {
  it(
    "writes one CLOSED trade, linked to both orders and the position",
    async () => {
      const runtime = await boot();
      try {
        await roundTrip(runtime, 100, 110, 10); // +100 gross
      } finally {
        await runtime.shutdown();
      }

      const trades = await mongo?.db
        .collection("trades")
        .find({}, { projection: { _id: 0 } })
        .toArray();
      expect(trades).toHaveLength(1);
      expect(trades?.[0]).toMatchObject({
        strategyId: STRATEGY,
        symbol: SYMBOL,
        side: "LONG",
        status: "CLOSED",
        entryOrderId: "ord_restart_in",
        exitOrderId: "ord_restart_out",
        orderIds: ["ord_restart_in", "ord_restart_out"],
        grossPnl: 100,
      });

      // Resolved from the Position Engine the runtime awaits first.
      const position = await mongo?.db
        .collection("positions")
        .findOne({ strategyId: STRATEGY, symbol: SYMBOL });
      expect(position?.["positionId"]).toBeDefined();
      expect(trades?.[0]?.["positionId"]).toBe(position?.["positionId"]);
    },
    RESTART_TIMEOUT_MS,
  );

  /**
   * A broker repeats the closing update after the process restarted. The
   * trade has left memory by then; only the durable check knows the fill was
   * already folded in, and without it this records a SHORT never entered.
   */
  it(
    "records no second trade when the closing fill is redelivered after a restart",
    async () => {
      const first = await boot();
      try {
        await roundTrip(first, 100, 110, 10);
      } finally {
        await first.shutdown();
      }

      const second = await boot();
      try {
        await second.bus.publish("ORDER_FILLED", {
          orderId: "ord_restart_out",
          strategyId: STRATEGY,
          symbol: SYMBOL,
          side: "SELL",
          qty: 10,
          filledPrice: 110,
          slippage: 0,
          charges: 0,
          filledAt: 2,
          mode: "paper",
          ts: 2,
        });
        // A fixed wait, unlike `roundTrip`: the expected outcome is that
        // NOTHING changes, which no condition can wait for. Long enough for
        // one fill's writes against hosted Mongo, so the assertion below
        // cannot pass merely because the redelivery was not processed yet.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      } finally {
        await second.shutdown();
      }

      const trades = await mongo?.db.collection("trades").find({}).toArray();
      expect(trades).toHaveLength(1);
      expect(trades?.[0]?.["status"]).toBe("CLOSED");
    },
    RESTART_TIMEOUT_MS,
  );
});

describe("paper reconciliation at runtime boot (Phase 14 D4)", () => {
  it(
    "durably halts, records the mismatch, and closes a broker-flat position",
    async () => {
      const db = mongo?.db;
      if (db === undefined) throw new Error("MongoDB is unavailable");

      const first = await boot();
      const openedAt = Date.now();
      try {
        await first.bus.publish("ORDER_FILLED", {
          orderId: "reconcile_runtime_entry",
          strategyId: STRATEGY,
          symbol: SYMBOL,
          side: "BUY",
          qty: 10,
          filledPrice: 100,
          slippage: 0,
          charges: 0,
          filledAt: openedAt,
          mode: "paper",
          ts: openedAt,
        });
        await vi.waitFor(
          async () => {
            expect(
              await db.collection("positions").countDocuments({
                strategyId: STRATEGY,
                symbol: SYMBOL,
                status: "OPEN",
              }),
            ).toBe(1);
          },
          { timeout: 20_000, interval: 50 },
        );
      } finally {
        await first.shutdown();
      }

      const paperBook = new PaperBrokerOrdersRepository(db);
      await paperBook.record({
        clientOrderId: "reconcile_runtime_entry",
        brokerOrderId: "paper_entry",
        symbol: SYMBOL,
        side: "BUY",
        qty: 10,
        type: "MARKET",
        status: "FILLED",
        filledPrice: 100,
        filledQty: 10,
        slippage: 0,
        charges: 0,
        filledAt: openedAt,
        recordedAt: Date.now(),
      });
      await paperBook.record({
        clientOrderId: "reconcile_runtime_exit",
        brokerOrderId: "paper_exit",
        symbol: SYMBOL,
        side: "SELL",
        qty: 10,
        type: "MARKET",
        status: "FILLED",
        filledPrice: 105,
        filledQty: 10,
        slippage: 0,
        charges: 0,
        filledAt: openedAt + 1,
        recordedAt: Date.now(),
      });

      const second = await boot();
      try {
        expect(second.positionEngine.getOpenPositions()).toHaveLength(0);
        expect(
          (await new SettingsRepository(db).getGlobal()).tradingEnabled,
        ).toBe(false);
      } finally {
        await second.shutdown();
      }

      const riskEvents = await new RiskEventsRepository(db).findRecent(10);
      expect(riskEvents).toHaveLength(1);
      expect(riskEvents[0]?.mismatches).toContainEqual(
        expect.objectContaining({
          kind: "POSITION",
          symbol: SYMBOL,
          tradingValue: "10",
          brokerValue: "0",
        }),
      );
      // Both boots are on record, clean or not (D6): the report reads these
      // to say the session was reconciled and that a restart happened.
      const runs = await db
        .collection("paper_reconciliations")
        .find({}, { projection: { _id: 0 } })
        .sort({ ts: 1 })
        .toArray();
      expect(runs).toEqual([
        expect.objectContaining({ at: "BOOT", clean: true, mismatches: 0 }),
        expect.objectContaining({
          at: "BOOT",
          clean: false,
          riskEventId: riskEvents[0]?.riskEventId,
        }),
      ]);
      expect(
        await db.collection("orders").findOne({
          orderId: { $regex: "^reconciliation:" },
          exitReason: "BROKER_RECONCILIATION",
          status: "FILLED",
        }),
      ).not.toBeNull();
      expect(
        await db.collection("positions").findOne({
          strategyId: STRATEGY,
          symbol: SYMBOL,
          status: "OPEN",
        }),
      ).toBeNull();
      expect(
        await db.collection("trades").findOne({
          strategyId: STRATEGY,
          symbol: SYMBOL,
          status: "CLOSED",
          exitReason: "BROKER_RECONCILIATION",
        }),
      ).not.toBeNull();
    },
    RESTART_TIMEOUT_MS,
  );

  it(
    "reconciles a mismatch on the market-close transition",
    async () => {
      const db = mongo?.db;
      if (db === undefined) throw new Error("MongoDB is unavailable");

      const openTs = Date.UTC(2024, 0, 3, 3, 45);
      const filledAt = openTs + 60_000;
      const closeTs = Date.UTC(2024, 0, 3, 10, 0);
      const runtime = await boot();
      try {
        await runtime.bus.publish("ORDER_FILLED", {
          orderId: "reconcile_close_entry",
          strategyId: STRATEGY,
          symbol: SYMBOL,
          side: "BUY",
          qty: 10,
          filledPrice: 100,
          slippage: 0,
          charges: 0,
          filledAt,
          mode: "paper",
          ts: filledAt,
        });
        await vi.waitFor(
          async () => {
            expect(
              await db.collection("positions").countDocuments({
                strategyId: STRATEGY,
                symbol: SYMBOL,
                status: "OPEN",
              }),
            ).toBe(1);
          },
          { timeout: 20_000, interval: 50 },
        );

        const paperBook = new PaperBrokerOrdersRepository(db);
        await paperBook.record({
          clientOrderId: "reconcile_close_entry",
          brokerOrderId: "paper_close_entry",
          symbol: SYMBOL,
          side: "BUY",
          qty: 10,
          type: "MARKET",
          status: "FILLED",
          filledPrice: 100,
          filledQty: 10,
          slippage: 0,
          charges: 0,
          filledAt,
          recordedAt: filledAt,
        });
        await paperBook.record({
          clientOrderId: "reconcile_close_exit",
          brokerOrderId: "paper_close_exit",
          symbol: SYMBOL,
          side: "SELL",
          qty: 10,
          type: "MARKET",
          status: "FILLED",
          filledPrice: 105,
          filledQty: 10,
          slippage: 0,
          charges: 0,
          filledAt: filledAt + 1,
          recordedAt: filledAt + 1,
        });

        await runtime.syncSession(openTs);
        await runtime.syncSession(closeTs);

        expect(
          await db
            .collection("paper_reconciliations")
            .findOne({ at: "CLOSE" }, { projection: { _id: 0 } }),
        ).toMatchObject({ clean: false, ts: closeTs });
        expect(runtime.positionEngine.getOpenPositions()).toHaveLength(0);
        expect(
          (await new SettingsRepository(db).getGlobal()).tradingEnabled,
        ).toBe(false);
        expect(
          await db.collection("risk_events").countDocuments({
            type: "BROKER_RECONCILIATION",
          }),
        ).toBe(1);
        expect(
          await db.collection("trades").findOne({
            strategyId: STRATEGY,
            symbol: SYMBOL,
            status: "CLOSED",
            exitReason: "BROKER_RECONCILIATION",
          }),
        ).not.toBeNull();
      } finally {
        await runtime.shutdown();
      }
    },
    RESTART_TIMEOUT_MS,
  );
});

describe("watched paper LIMIT orders (Phase 14 D5)", () => {
  it(
    "fills from runtime market ticks and expires pending orders at session close",
    async () => {
      const db = mongo?.db;
      if (db === undefined) throw new Error("MongoDB is unavailable");
      const openTs = Date.UTC(2024, 0, 3, 3, 45);
      const tickTs = openTs + 60_000;
      const closeTs = Date.UTC(2024, 0, 3, 10, 0);
      const book = new PaperBrokerOrdersRepository(db);
      const paper = new PaperBroker({
        readPrice: () => Promise.resolve(100),
        readSessionOpen: () => Promise.resolve(true),
        book,
        now: () => closeTs,
        nextBrokerOrderId: () => "paper_limit_order",
      });
      const runtime = await boot(paper);
      try {
        await runtime.syncSession(openTs);
        const fillOutcome = await paper.execute({
          clientOrderId: "runtime_limit_fill",
          symbol: SYMBOL,
          side: "BUY",
          qty: 1,
          type: "LIMIT",
          price: 99,
        });
        expect(fillOutcome.status).toBe("PENDING");

        await runtime.bus.publish("MARKET_TICK", {
          symbol: SYMBOL,
          ltp: 98,
          volume: 1,
          ts: tickTs,
        });
        await vi.waitFor(
          async () => {
            expect((await paper.status("runtime_limit_fill")).status).toBe(
              "FILLED",
            );
          },
          { timeout: 10_000, interval: 50 },
        );
        expect(await book.find("runtime_limit_fill")).toMatchObject({
          status: "FILLED",
          filledPrice: 99,
          filledAt: tickTs,
        });

        const expireOutcome = await paper.execute({
          clientOrderId: "runtime_limit_expire",
          symbol: SYMBOL,
          side: "BUY",
          qty: 1,
          type: "LIMIT",
          price: 90,
        });
        expect(expireOutcome.status).toBe("PENDING");
        await runtime.syncSession(closeTs);

        expect(await paper.status("runtime_limit_expire")).toMatchObject({
          status: "CANCELLED",
        });
        expect(await book.find("runtime_limit_expire")).toMatchObject({
          status: "CANCELLED",
          reason: "session closed",
        });
      } finally {
        await runtime.shutdown();
      }
    },
    RESTART_TIMEOUT_MS,
  );
});
