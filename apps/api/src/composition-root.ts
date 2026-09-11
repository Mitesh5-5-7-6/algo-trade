import type { Config } from "@neelkanth/config";
import { componentLogger, type Logger } from "@neelkanth/logger";
import {
  createRedisConnections,
  redactRedisUrl,
  verifyRedisConnection,
  webhookChannel,
  webhookInboxKey,
  WEBHOOK_INBOX_MAX,
  type RedisConnections,
} from "@neelkanth/redis";
import {
  connectMongo,
  ensureIndexes,
  SettingsRepository,
  UsersRepository,
  BrokerTokensRepository,
  type MongoConnection,
} from "@neelkanth/db";
import cors from "@fastify/cors";
import { buildServer, type ApiServer } from "./server.js";
import type { DependencyCheck } from "./health.js";
import { startEngineRuntime, type EngineRuntime } from "./engines/runtime.js";
import { createLiveMarketState } from "./engines/live-market-state.js";
import {
  meterRedis,
  RedisMeter,
  startRedisMeterReport,
} from "./engines/redis-meter.js";
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
import { registerFyersAuthRoutes } from "./auth/fyers.js";
import { registerFyersWebhookRoutes } from "./webhooks/index.js";
import { isCrossSite } from "./auth/same-site.js";
import { corsOptions } from "./cors.js";
import { startTokenLifecycleJobs } from "./jobs/token-lifecycle.js";
import { createRealtimeBridge } from "./realtime/index.js";
import { FyersBroker, PaperBroker, type Broker } from "@neelkanth/broker";

/** How often the session state is re-evaluated (plan/17 §6). */
const SESSION_POLL_MS = 15_000;
/** Day-curve sampling cadence (plan/06 §4): one point a minute while open. */
const EQUITY_SAMPLE_MS = 60_000;

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

  // Prove Redis answers before going further. Mongo was verified by its own
  // ping above; without the matching check here the first failure would be a
  // bare MaxRetriesPerRequestError thrown from deep inside engine wiring,
  // naming neither Redis nor the host (plan/22 §4: die legibly, not late).
  await verifyRedisConnection(redis, config.REDIS_URL);
  log.info({ redis: redactRedisUrl(config.REDIS_URL) }, "redis reachable");

  // Optional command-rate diagnostic (dev): REDIS_METER_MS=15000 to enable.
  // Counts in memory only — a meter that stored its numbers in Redis would be
  // part of what it is measuring.
  const meterMs = Number(process.env["REDIS_METER_MS"] ?? 0);
  let stopMeter: (() => void) | undefined;
  if (meterMs > 0) {
    const meter = new RedisMeter();
    redis.client = meterRedis(redis.client, meter);
    redis.publisher = meterRedis(redis.publisher, meter);
    stopMeter = startRedisMeterReport(meter, componentLogger(logger, "redis.meter"), meterMs);
    log.info({ intervalMs: meterMs }, "redis command meter enabled");
  }

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

  // Repositories needed by broker token lookup (declared before broker so
  // the getToken closure can reference them).
  const users = new UsersRepository(mongo.db);
  const brokerTokens = new BrokerTokensRepository(
    mongo.db,
    config.TOKEN_ENCRYPTION_KEY,
  );

  // --- Broker (plan/19 §2) ---
  const brokerLog = componentLogger(logger, "api.broker");
  // Shared by the Paper Broker (reader) and the engine runtime (writer).
  const liveState = createLiveMarketState();
  let broker: Broker;
  let fyersBroker: FyersBroker | null = null;
  if (config.FYERS_APP_ID && config.FYERS_APP_SECRET) {
    fyersBroker = new FyersBroker({
      appId: config.FYERS_APP_ID,
      // FYERS access tokens last about a day, and nothing refreshes them yet
      // (jobs/token-lifecycle is still a stub). So the ordinary morning state
      // is "a token exists and is stale" — and handing a stale one to the SDK
      // just makes it throw while decoding the JWT, which surfaced as a bare
      // NO FEED indistinguishable from a network fault.
      //
      // Checked here, where a logger exists, so the reason is stated once and
      // plainly instead of being inferred from a silent disconnect.
      getToken: async () => {
        const user = await users.findFirstUser();
        if (!user) {
          brokerLog.warn("no operator account — cannot load a FYERS token");
          return null;
        }
        const token = await brokerTokens.getDecryptedToken(user.userId);
        if (!token) {
          brokerLog.warn(
            "no FYERS token stored — connect the broker from Settings",
          );
          return null;
        }
        if (token.expiresAt <= Date.now()) {
          brokerLog.warn(
            { expiredAt: new Date(token.expiresAt).toISOString() },
            "FYERS access token EXPIRED — reconnect from Settings; the feed " +
              "stays down until a fresh token is stored (plan/19 §3)",
          );
          return null;
        }
        return token.accessToken;
      },
    });
  }

  if (config.BROKER_MODE === "live" && fyersBroker) {
    broker = fyersBroker;
  } else {
    // Paper mode (plan/11): execution is simulated, data is real FYERS (if credentials exist)
    // Reads the same in-memory state the engine decides on, not a Redis copy
    // of it. Two sources for one price is a correctness problem before it is a
    // cost one: the broker could fill at a value risk never sized against, and
    // `hot:session` had a documented history of disagreeing with itself.
    const paper = new PaperBroker({
      readPrice: (symbol) =>
        Promise.resolve(liveState.prices.get(symbol) ?? null),
      readSessionOpen: () => Promise.resolve(liveState.sessionOpen),
    });

    if (fyersBroker) {
      broker = {
        connect: () => fyersBroker.connect(),
        disconnect: () => fyersBroker.disconnect(),
        subscribe: (symbols) => fyersBroker.subscribe(symbols),
        onData: (cb) => {
          fyersBroker.onData(cb);
        },
        onConnectionChange: (cb) => {
          fyersBroker.onConnectionChange(cb);
        },
        execute: (order) => paper.execute(order),
        cancel: (id) => paper.cancel(id),
        status: (id) => paper.status(id),
        onOrderUpdate: (cb) => {
          paper.onOrderUpdate(cb);
        },
      };
    } else {
      broker = paper;
    }
  }

  // --- Runtime (plan/05 §3) ---
  const runtime = await startEngineRuntime({
    redis,
    mongo,
    logger,
    broker,
    mode: config.BROKER_MODE,
    liveState,
  });

  // Establish the broker data feed (plan/19 §4).
  // Done before enabling strategies so indicator warm-up has live prices.
  await broker.connect();

  await runtime.syncSession(Date.now()); // initial session state
  const sessionTimer = setInterval(() => {
    void runtime.syncSession(Date.now());
  }, SESSION_POLL_MS);
  sessionTimer.unref(); // never keep the process alive on the timer alone
  const equityTimer = setInterval(() => {
    runtime.sampleEquity(Date.now());
  }, EQUITY_SAMPLE_MS);
  equityTimer.unref();

  let tokenLifecycle: { close(): Promise<void> } | undefined;
  if (
    config.BROKER_MODE === "live" &&
    config.FYERS_APP_ID &&
    config.FYERS_APP_SECRET
  ) {
    tokenLifecycle = await startTokenLifecycleJobs({
      redis,
      brokerTokens,
      logger,
      fyersAppId: config.FYERS_APP_ID,
      fyersAppSecret: config.FYERS_APP_SECRET,
    });
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

  // --- Auth (plan/21) + control-plane routes (plan/05 §4.1) ---
  // Sessions + login throttle live in Redis; the guard hook must be registered
  // before the routes it protects, so it runs on them. Cookies are Secure only
  // in production (dev serves plain HTTP).
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
  // A dashboard on a different registrable domain never receives a
  // SameSite=Lax cookie, so the session would silently never arrive and every
  // authenticated request would 401 (see auth/same-site.ts).
  const crossSiteCookies = isCrossSite(
    config.DASHBOARD_ORIGIN,
    config.PUBLIC_API_ORIGIN,
  );
  if (crossSiteCookies) {
    log.warn(
      { dashboardOrigin: config.DASHBOARD_ORIGIN },
      "dashboard is a different site than the API: session cookies use " +
        "SameSite=None, forfeiting the CSRF protection of plan/21 §3",
    );
  }

  const server = buildServer({ logger, readinessChecks });
  // CORS with credentials so the dashboard (a separate origin in dev; same
  // origin behind the reverse proxy in prod, plan/22 §2) can send the session
  // cookie. Exactly one origin is allowed — never `*` with credentials.
  await server.register(cors, corsOptions(config.DASHBOARD_ORIGIN));
  registerAuthGuard(server, {
    sessions,
    users,
    secureCookies,
    crossSiteCookies,
  });
  registerAuthRoutes(server, {
    users,
    sessions,
    rateLimiter,
    secureCookies,
    crossSiteCookies,
  });
  // Registered in BOTH modes, not just live. Paper trading executes on the
  // simulator but takes its prices from the real FYERS feed (plan/19 §2), and
  // that feed needs an access token — which only this OAuth round trip can
  // produce. Gating these routes on live mode left paper mode unable to obtain
  // the token it depends on: the feed then fails closed and silently, and the
  // system looks alive while no market data ever arrives.
  if (
    config.FYERS_APP_ID &&
    config.FYERS_APP_SECRET &&
    config.FYERS_REDIRECT_URL
  ) {
    registerFyersAuthRoutes(server, {
      fyersAppId: config.FYERS_APP_ID,
      fyersAppSecret: config.FYERS_APP_SECRET,
      fyersRedirectUrl: config.FYERS_REDIRECT_URL,
      dashboardOrigin: config.DASHBOARD_ORIGIN,
      brokerTokens,
      // Reconnect the feed with the token that was just stored. The daily
      // expiry makes this the normal morning path, and without it the button
      // would store a valid token while the feed stayed down until a restart.
      onTokenStored: async () => {
        brokerLog.info("fresh FYERS token stored — reconnecting the feed");
        await broker.connect();
      },
    });
  }
  // --- Broker webhooks (plan/19 §4) ---
  // FYERS posts order/trade callbacks here. The handler does not touch the
  // engines directly: it parks the delivery in Redis and returns. A webhook is
  // fire-and-forget from the broker's side — there is no redelivery — so the
  // only thing that must happen inside the request is durable persistence.
  // Consumers drain the inbox at their own pace and stay idempotent
  // (plan/09 §5), which also means a slow pipeline can never make the broker
  // time out and disable the webhook.
  registerFyersWebhookRoutes(server, {
    secret: config.FYERS_WEBHOOK_SECRET,
    deliver: async (event) => {
      const record = JSON.stringify(event);
      const inbox = webhookInboxKey("fyers");
      // One round trip: the list is the record, the publish is a nudge for
      // consumers already listening (plan/08 §3). LTRIM caps the backlog so a
      // stalled consumer degrades to lost history, never to a full Redis.
      await redis.client
        .multi()
        .lpush(inbox, record)
        .ltrim(inbox, 0, WEBHOOK_INBOX_MAX - 1)
        .publish(webhookChannel("fyers"), record)
        .exec();
    },
  });

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
      clearInterval(equityTimer);
      stopMeter?.();
      shutdownLog.info("closing realtime bridge + http server");
      // The bridge owns the shared HTTP server's close (io.close closes it too),
      // so this stands in for server.close() — calling both would double-close.
      await bridge.close().catch((err: unknown) => {
        shutdownLog.error({ err }, "error closing realtime bridge");
      });
      if (tokenLifecycle) {
        shutdownLog.info("closing token lifecycle jobs");
        await tokenLifecycle.close().catch((err: unknown) => {
          shutdownLog.error({ err }, "error closing token lifecycle");
        });
      }
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
