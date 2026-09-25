import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@neelkanth/logger";
import { ScriptedFakeBroker } from "@neelkanth/broker";
import {
  connectMongo,
  ensureIndexes,
  type MongoConnection,
} from "@neelkanth/db";
import {
  createRedisConnections,
  riskDailyLossKey,
  type RedisConnections,
} from "@neelkanth/redis";
import { istDateKey } from "@neelkanth/engines";
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
async function boot(): Promise<EngineRuntime> {
  if (mongo === undefined || redis === undefined) {
    throw new Error("infrastructure not probed");
  }
  return startEngineRuntime({
    redis,
    mongo,
    logger: silentLogger(),
    broker: new ScriptedFakeBroker(),
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
  // The fill → position → PnL → ledger chain crosses the bus, so it settles a
  // tick or two after publish returns.
  await new Promise((resolve) => setTimeout(resolve, 300));
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

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe("the day's risk state survives a restart (§0.8)", () => {
  /**
   * The failing scenario, end to end: lose money in the morning, crash, come
   * back. Before §0.5.4 the second process saw a flat day and would have
   * allowed the afternoon to lose the same amount again against one limit.
   */
  it("restores the morning's realized loss into a second process", async () => {
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
  });

  /**
   * The adapter itself: the key builder, the serialization, and the fact that
   * something writes at all. Asserted against the real key so a typo in
   * `riskDailyLossKey` cannot pass.
   */
  it("writes the counter to the key the namespace table reserved", async () => {
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
  });

  /**
   * The counter must outlive an overnight restart, so a TTL shorter than a
   * trading day would silently reintroduce the bug on the next morning's boot.
   */
  it("keeps the counter alive well beyond one trading day", async () => {
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
  });

  /**
   * A profitable day is not a loss. `lossFrom` clamps at zero, and the gate
   * compares a positive number against a positive limit — a negative loss
   * would make the comparison meaningless rather than merely wrong.
   */
  it("restores a profitable day as a profit, not a negative loss", async () => {
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
  });
});
