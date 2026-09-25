import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@neelkanth/config";
import { createLogger } from "@neelkanth/logger";
import type { StrategyConfig } from "@neelkanth/core";
import {
  connectMongo,
  SettingsRepository,
  StrategiesRepository,
} from "@neelkanth/db";
import { createRedisConnections, riskDailyLossKey } from "@neelkanth/redis";
import { istDateKey } from "@neelkanth/engines";
import { bootstrap, type AppContext } from "./composition-root.js";
import { STRICT } from "./test-support/infra.js";

/**
 * Integration test for the composition root (plan/05 §3) against REAL Redis +
 * Mongo. It exercises the full boot wiring — engines constructed, bus
 * subscriptions established, the boot sequence (hydrate / reconcile / enable
 * strategies + warm indicators) — and the graceful shutdown (plan/22 §4),
 * which can't be driven via SIGTERM on a Windows dev box.
 *
 * Requires both Redis and Mongo (the pipeline needs Redis to wire the bus);
 * skips when either is unreachable (local dev without Docker). CI's service
 * containers always provide both.
 */
/** The one database this suite is ever allowed to touch. */
const IT_DB = "neelkanth_it_ctx";

/**
 * Point a Mongo URI at an isolated test database, whatever it originally named.
 *
 * This suite drops its database to get a clean slate, and `connectMongo` falls
 * back to the database named IN THE URI when no name is passed — as does
 * `bootstrap` itself (composition-root.ts). So an operator exporting the real
 * `MONGO_URI` and running the tests would have dropped production. Rewriting
 * the URI rather than passing a `dbName` is what makes the isolation hold for
 * BOTH connections: the one below and the one `bootstrap` opens from the config.
 *
 * Only the database segment is replaced. Credentials, `+srv`, replica-set seed
 * lists and query parameters are all preserved, so an Atlas URI still connects.
 */
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

/** The database segment a URI resolves to — what `connectMongo` would open. */
function databaseOf(uri: string): string {
  const queryAt = uri.indexOf("?");
  const base = queryAt === -1 ? uri : uri.slice(0, queryAt);
  const schemeEnd = base.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = base.indexOf("/", authorityStart);
  return pathStart === -1 ? "" : base.slice(pathStart + 1);
}

const MONGO_URI = isolate(
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder",
  IT_DB,
);
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

/**
 * Refuse to load at all unless the URI resolves to an isolated database.
 *
 * Deliberately at module scope, not inside `beforeAll`: the probe there catches
 * everything in order to skip when infrastructure is absent, so a guard placed
 * inside it would be swallowed into a silent skip. A refusal to drop somebody's
 * production data must be the loudest thing in the run, not the quietest.
 */
if (!/^neelkanth_(it|ci)_/.test(databaseOf(MONGO_URI))) {
  throw new Error(
    `refusing to run: MONGO_URI resolves to database "${databaseOf(MONGO_URI)}" — ` +
      "this suite drops its database and may only ever target " +
      "neelkanth_it_* or neelkanth_ci_*",
  );
}

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

function testConfig(): Config {
  return loadConfig({
    MONGO_URI,
    REDIS_URL,
    SESSION_SECRET: "s".repeat(40),
    TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    LOG_LEVEL: "fatal",
  });
}

/**
 * `bootstrap()` opens Mongo and Redis, wires every engine, hydrates positions,
 * reconciles orders and warms indicators. Against hosted instances across a
 * region that does not fit vitest's 5s default — and the failure reads as a
 * broken boot rather than a slow one.
 */
const BOOT_TIMEOUT_MS = 60_000;

const enabledStrategy: StrategyConfig = {
  strategyId: "str_boot",
  ownerId: "usr_boot",
  type: "EMA_CROSSOVER",
  name: "EMA boot",
  params: { fast: 9, slow: 21, quantity: 10 },
  symbols: ["NSE:BOOT-EQ"],
  enabled: true,
  status: "active",
  // `TimestampSchema` is `.positive()`, so 0 fails validation — and for two
  // and a half years the only symptom was this suite reporting "MongoDB
  // unreachable", because the probe's `catch` threw the Zod error away.
  createdAt: 1,
  updatedAt: 1,
};

let infraAvailable = false;
let failure = "";

beforeAll(async () => {
  let mongoOk = false;
  try {
    const mongo = await connectMongo(MONGO_URI, IT_DB);
    await mongo.db.dropDatabase(); // clean slate → getGlobal seeds fresh
    // Seed an enabled strategy + capital so boot exercises the enable path.
    await new StrategiesRepository(mongo.db).create(enabledStrategy);
    await new SettingsRepository(mongo.db).updateGlobal({
      capitalAllocation: 1_000_000,
    });
    await mongo.close();
    mongoOk = true;
  } catch (error) {
    // Keep the reason. Discarding it made "no database" and "the seed threw"
    // report identically, which is the ambiguity this suite exists to avoid.
    mongoOk = false;
    failure = error instanceof Error ? error.message : String(error);
  }

  let redisOk = false;
  try {
    const redis = createRedisConnections(REDIS_URL, () => {
      /* swallow probe-time connection errors */
    });
    await redis.client.ping();
    // Every suite drops its Mongo database for a clean slate; nothing did the
    // same for Redis, so this one inherited whatever the last suite left in
    // `risk:dailyLoss:<date>` and booted with a restored P&L. That is the
    // feature working exactly as designed — and it made this suite fail for a
    // reason that had nothing to do with it.
    await redis.client.del(riskDailyLossKey(istDateKey(Date.now())));
    await redis.quit();
    redisOk = true;
  } catch (error) {
    redisOk = false;
    // Keep the FIRST reason: Mongo is probed first, and if both are down its
    // failure is the more useful one to report.
    if (failure === "") {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  infraAvailable = mongoOk && redisOk;
  if (infraAvailable) return;

  // This suite already skipped when infrastructure was absent — silently, which
  // is the half of the problem §0.4 exists to fix. A skipped suite and a
  // passing one produced the same `0 failed`.
  const missing = [mongoOk ? null : "MongoDB", redisOk ? null : "Redis"]
    .filter((name) => name !== null)
    .join(" and ");
  if (STRICT) {
    throw new Error(
      `composition-root.integration.test.ts: ${missing} unreachable and ` +
        `REQUIRE_INTEGRATION=1 — ${failure}`,
    );
  }
  const line = "#".repeat(74);
  process.stderr.write(
    `\n${line}\n` +
      `INTEGRATION SUITE NOT RUN — apps/api/src/composition-root.integration.test.ts\n` +
      `  These tests were NOT EXECUTED. Skipped is not passed.\n` +
      `  reason : ${missing} unreachable${failure === "" ? "" : ` — ${failure}`}\n` +
      // Redacted: a hosted REDIS_URL carries its password, and a banner is
      // exactly the thing that ends up pasted into an issue or a chat.
      `  target : database "${IT_DB}", ${REDIS_URL.replace(/\/\/[^@/]*@/, "//<credentials>@")}\n` +
      `  fix    : docker compose -f docker-compose.test.yml up -d\n` +
      `  strict : run \`pnpm test:integration\` to make this a hard failure\n` +
      `${line}\n\n`,
  );
});

function requireInfra(ctx: { skip: () => void }): void {
  if (!infraAvailable) ctx.skip();
}

describe("bootstrap (plan/05 §3 composition root)", () => {
  let context: AppContext | undefined;

  afterAll(async () => {
    if (context) await context.shutdown();
  });

  it(
    "wires the engines, boots a ready server, and enables strategies",
    async (ctx) => {
      requireInfra(ctx);
      context = await bootstrap(testConfig(), silentLogger());

      const live = await context.server.inject({
        method: "GET",
        url: "/health/live",
      });
      expect(live.statusCode).toBe(200);

      const ready = await context.server.inject({
        method: "GET",
        url: "/health/ready",
      });
      expect(ready.statusCode).toBe(200); // both deps up in CI
      const body = ready.json<{ dependencies: Record<string, string> }>();
      expect(body.dependencies["mongo"]).toBe("up");
      expect(body.dependencies["redis"]).toBe("up");

      // Equity sampler: a crafted open-market instant (Mon 2026-01-05 10:00 IST)
      // records a point regardless of when CI runs; a closed instant does not.
      const istOffset = (5 * 60 + 30) * 60_000;
      const openInstant = Date.UTC(2026, 0, 5, 10, 0) - istOffset;
      const closedSameDay = Date.UTC(2026, 0, 5, 16, 0) - istOffset; // post-close
      context.runtime.sampleEquity(openInstant);
      context.runtime.sampleEquity(closedSameDay); // same IST day → not recorded
      expect(context.runtime.equityCurve()).toEqual([
        { ts: openInstant, realizedPnl: 0, unrealizedPnl: 0 },
      ]);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "shuts down cleanly without throwing (plan/22 §4)",
    async (ctx) => {
      requireInfra(ctx);
      const local = await bootstrap(testConfig(), silentLogger());
      await expect(local.shutdown()).resolves.toBeUndefined();
    },
    BOOT_TIMEOUT_MS,
  );
});
