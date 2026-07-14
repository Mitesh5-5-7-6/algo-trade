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
  UsersRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { buildServer, type ApiServer } from "./server.js";
import type { DependencyCheck } from "./health.js";
import { startEngineRuntime, type EngineRuntime } from "./engines/runtime.js";
import { registerControlPlane } from "./control-plane/index.js";
import {
  createStepUpVerifier,
  LoginRateLimiter,
  LOGIN_RATE_LIMIT,
  redisRateLimitKV,
  redisSessionKV,
  registerAuthGuard,
  registerAuthRoutes,
  SessionStore,
  SESSION_ABSOLUTE_MAX_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
} from "./auth/index.js";
import { createRealtimeBridge } from "./realtime/index.js";

/** How often the session state is re-evaluated (plan/17 §6). */
const SESSION_POLL_MS = 15_000;

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
  readonly runtime: EngineRuntime;
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

  // --- Construct + wire the engines (plan/05 §3) ---
  // The pipeline: engines built with real Redis/Mongo ports, subscribed to the
  // bus. Boot sequence (hydrate positions, reconcile stuck orders, enable
  // strategies + warm indicators) runs inside. The Market Data Engine + FYERS
  // feed attach to the same bus once broker credentials exist (plan/19).
  log.info("wiring engines");
  const runtime = await startEngineRuntime({ redis, mongo, logger });
  await runtime.syncSession(Date.now()); // initial session state
  const sessionTimer = setInterval(() => {
    void runtime.syncSession(Date.now());
  }, SESSION_POLL_MS);
  sessionTimer.unref(); // never keep the process alive on the timer alone

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

  // --- Auth (plan/21) + control-plane routes (plan/05 §4.1) ---
  // Sessions + login throttle live in Redis; the guard hook must be registered
  // before the routes it protects, so it runs on them. Cookies are Secure only
  // in production (dev serves plain HTTP).
  const users = new UsersRepository(mongo.db);
  const sessions = new SessionStore(
    redisSessionKV(redis.client),
    SESSION_IDLE_TTL_SECONDS,
    SESSION_ABSOLUTE_MAX_SECONDS,
  );
  const rateLimiter = new LoginRateLimiter(
    redisRateLimitKV(redis.client),
    LOGIN_RATE_LIMIT,
  );
  const secureCookies = config.NODE_ENV === "production";

  const server = buildServer({ logger, readinessChecks });
  registerAuthGuard(server, { sessions, users, secureCookies });
  registerAuthRoutes(server, { users, sessions, rateLimiter, secureCookies });
  registerControlPlane(server, {
    db: mongo.db,
    runtime,
    verifyStepUp: createStepUpVerifier(users),
  });

  // --- Realtime bridge (plan/10): push live state to the dashboard ---
  // Attaches Socket.IO to the same HTTP server, authenticates the handshake
  // with the same sessions, and forwards the engine bus outward. A leaf: it
  // only consumes events (plan/02 §11), so a stuck dashboard can't touch the
  // pipeline. It becomes the owner of the shared HTTP server's close.
  const bridge = await createRealtimeBridge({
    httpServer: server.server,
    bus: runtime.bus,
    sessions,
    users,
    logger,
    corsOrigin: config.DASHBOARD_ORIGIN,
  });

  return {
    config,
    logger,
    redis,
    mongo,
    server,
    runtime,
    async shutdown() {
      // Reverse order; each step best-effort so one failure can't strand
      // the rest (plan/22 §4). (In-flight broker drain lands with the live
      // feed in Phase 3.)
      const shutdownLog = componentLogger(logger, "api.shutdown");
      clearInterval(sessionTimer);
      shutdownLog.info("closing realtime bridge + http server");
      // The bridge owns the shared HTTP server's close (io.close closes it too),
      // so this stands in for server.close() — calling both would double-close.
      await bridge.close().catch((err: unknown) => {
        shutdownLog.error({ err }, "error closing realtime bridge");
      });
      shutdownLog.info("closing engine runtime");
      await runtime.shutdown().catch((err: unknown) => {
        shutdownLog.error({ err }, "error closing runtime");
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
