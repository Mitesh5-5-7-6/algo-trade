import type { Config } from "@neelkanth/config";
import { componentLogger, type Logger } from "@neelkanth/logger";
import {
  createRedisConnections,
  type RedisConnections,
} from "@neelkanth/redis";
import {
  connectMongo,
  ensureIndexes,
  SettingsRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { buildServer, type ApiServer } from "./server.js";
import type { DependencyCheck } from "./health.js";

/**
 * The single composition root (plan/05 §3): the one place concrete infra —
 * Redis, Mongo, (later) the broker and engines — is instantiated and wired.
 * Nothing else constructs these; dependencies are injected, not reached for,
 * so each engine stays unit-testable with fakes.
 *
 * Boot order is the plan/05 §3 / plan/22 §4 sequence, in its Phase-0 form:
 *   config (already validated) → infra connects → indexes ensured →
 *   kill flag honored → server built → ready.
 * Engine construction, broker selection, and feed subscription slot in here
 * as Phase 1 lands, without changing the shape.
 */
export interface AppContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly redis: RedisConnections;
  readonly mongo: MongoConnection;
  readonly server: ApiServer;
  /** Graceful teardown (plan/22 §4), reverse order of construction. */
  shutdown(): Promise<void>;
}

export async function bootstrap(
  config: Config,
  logger: Logger,
): Promise<AppContext> {
  const log = componentLogger(logger, "api.bootstrap");

  // --- Infrastructure ---
  log.info("connecting mongo");
  const mongo = await connectMongo(config.MONGO_URI); // pings; throws if down
  log.info("connecting redis");
  // Connection errors during an outage repeat rapidly while ioredis retries;
  // throttle to one line per source per 30s so a real outage is visible
  // without drowning the log (plan/23 §3: levels used honestly).
  const redisLog = componentLogger(logger, "redis");
  const lastLoggedAt = new Map<string, number>();
  const redis = createRedisConnections(config.REDIS_URL, (error, source) => {
    const now = Date.now();
    const previous = lastLoggedAt.get(source) ?? 0;
    if (now - previous >= 30_000) {
      lastLoggedAt.set(source, now);
      redisLog.warn({ err: error, source }, "redis connection error");
    }
  });

  // --- Database design as code (plan/07): indexes idempotently ensured ---
  log.info("ensuring indexes");
  await ensureIndexes(mongo.db);

  // --- Honor the persisted kill flag (plan/07 settings, plan/12 §4) ---
  // A restart must never silently resume a killed system. We read the flag
  // at boot; when the Order Manager lands it gates on this same value.
  const settings = new SettingsRepository(mongo.db);
  const global = await settings.getGlobal();
  if (!global.tradingEnabled) {
    log.warn(
      { tradingEnabled: false },
      "trading is DISABLED at boot — operator must explicitly enable (plan/12 §4)",
    );
  }

  // --- Readiness probes (plan/23 §4) ---
  const readinessChecks: DependencyCheck[] = [
    {
      name: "mongo",
      probe: async () => {
        await mongo.db.command({ ping: 1 });
        return true;
      },
    },
    {
      name: "redis",
      probe: async () => {
        await redis.client.ping(); // resolves "PONG" or throws → down
        return true;
      },
    },
  ];

  // --- HTTP server ---
  const server = buildServer({ logger, readinessChecks });

  return {
    config,
    logger,
    redis,
    mongo,
    server,
    async shutdown() {
      // Reverse order; each step best-effort so one failure can't strand
      // the rest (plan/22 §4). Engines and in-flight broker drain slot in
      // ahead of these closes as Phase 1 lands.
      const shutdownLog = componentLogger(logger, "api.shutdown");
      shutdownLog.info("closing http server");
      await server.close().catch((err: unknown) => {
        shutdownLog.error({ err }, "error closing server");
      });
      shutdownLog.info("closing redis");
      await redis.quit();
      shutdownLog.info("closing mongo");
      await mongo.close().catch((err: unknown) => {
        shutdownLog.error({ err }, "error closing mongo");
      });
    },
  };
}
