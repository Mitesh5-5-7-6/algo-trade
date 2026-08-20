import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { MongoClient, type Db } from "mongodb";
import { createLogger } from "@neelkanth/logger";
import {
  BrokerTokensRepository,
  SettingsRepository,
  UsersRepository,
} from "@neelkanth/db";
import { buildServer, type ApiServer } from "../server.js";
import { registerControlPlane } from "../control-plane/index.js";
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
} from "../auth/index.js";
import { registerFyersAuthRoutes } from "../auth/fyers.js";
import { registerFyersWebhookRoutes, FYERS_WEBHOOK_PATH } from "../webhooks/index.js";
import { createRuntimeProjection } from "./runtime-projection.js";
import { isCrossSite } from "../auth/same-site.js";
import { corsOptions } from "../cors.js";
import {
  webhookChannel,
  webhookInboxKey,
  WEBHOOK_INBOX_MAX,
} from "@neelkanth/redis";

/**
 * The control plane as a serverless app — the same routes as
 * {@link ../composition-root.ts}, minus everything that needs to stay alive.
 *
 * This is NOT a second implementation of the API. It registers the exact same
 * `registerAuthRoutes` / `registerControlPlane` / `registerFyersWebhookRoutes`
 * the long-lived process does, so validation, the auth guard, the error
 * envelope and every handler are shared code. Only the composition differs.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY
 * ------------------------------------
 *  - **The engines.** `startEngineRuntime` builds strategy/risk/order/position
 *    engines that must run continuously; a function that dies after each
 *    response cannot host them. Their control-plane seam is filled by
 *    {@link createRuntimeProjection}, which reads the durable record instead.
 *  - **Socket.IO.** The realtime bridge (plan/10) needs a held-open connection.
 *    Serverless has no such thing, so the dashboard's live channel does not
 *    work against this deployment — only the REST half (plan/06 §5).
 *  - **BullMQ workers and the broker feed.** Same reason: both are long-lived.
 *  - **`ensureIndexes`.** Index creation is a boot-time job for the owning
 *    process, not something to re-run on every cold start.
 *
 * ⚠ Run this INSTEAD OF the long-lived process, never alongside it. Two control
 * planes writing the same settings with no coordination is exactly the kind of
 * split-brain a money system must not have.
 */

/** Reused across warm invocations; a cold start pays for it once. */
interface Cached {
  app: ApiServer;
  refresh: (now: number) => Promise<void>;
}
let cached: Cached | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function connectMongoForFunction(uri: string): Promise<Db> {
  // Small pool and short timeouts: a function instance serves one request at a
  // time, and hanging on an unreachable Mongo just burns the invocation.
  const client = new MongoClient(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 8_000,
  });
  await client.connect();
  return client.db();
}

async function build(): Promise<Cached> {
  const logger = createLogger({
    level: (process.env["LOG_LEVEL"] ?? "info") as "info",
    name: "api-serverless",
  });

  const db = await connectMongoForFunction(required("MONGO_URI"));
  const redis = new Redis(required("REDIS_URL"), {
    maxRetriesPerRequest: 3,
    connectTimeout: 8_000,
  });
  // Reported through the failed command that caused it; this listener only
  // stops an unhandled 'error' event from killing the instance.
  redis.on("error", () => undefined);

  const users = new UsersRepository(db);
  const sessions = new SessionStore(
    redisSessionKV(redis),
    SESSION_IDLE_TTL_SECONDS,
    SESSION_ABSOLUTE_MAX_SECONDS,
  );
  const rateLimiter = new LoginRateLimiter(
    redisRateLimitKV(redis),
    LOGIN_RATE_LIMIT,
  );
  const runtime = createRuntimeProjection(db, redis);

  const app = buildServer({
    logger,
    readinessChecks: [
      {
        name: "mongo",
        probe: async () => {
          await db.command({ ping: 1 });
          return true;
        },
      },
      {
        name: "redis",
        probe: async () => {
          await redis.ping();
          return true;
        },
      },
    ],
  });

  // Exactly one origin, never `*` — `credentials: true` forbids the wildcard,
  // and the dashboard must send the session cookie.
  await app.register(cors, corsOptions(required("DASHBOARD_ORIGIN")));

  // The projection serves synchronous reads, so the durable state has to be in
  // hand before any handler runs. Skipped for the probes and the webhook:
  // neither reads runtime state, and both are called far more often than the
  // dashboard's routes.
  const SKIP_REFRESH = new Set([
    "/health/live",
    "/health/ready",
    FYERS_WEBHOOK_PATH,
  ]);
  app.addHook("onRequest", async (request) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (SKIP_REFRESH.has(pathname)) return;
    await runtime.refresh(Date.now());
  });

  // Cookies are Secure in production. Cross-site is derived, not configured:
  // two `*.vercel.app` subdomains are different sites, so a Lax cookie would
  // never be sent and every authenticated call would 401. Comparing the
  // registrable domains is what tells us which case we are in.
  const secureCookies = process.env["NODE_ENV"] === "production";
  const crossSiteCookies = isCrossSite(
    required("DASHBOARD_ORIGIN"),
    process.env["PUBLIC_API_ORIGIN"],
  );
  if (crossSiteCookies) {
    logger.warn(
      { dashboardOrigin: required("DASHBOARD_ORIGIN") },
      "dashboard is a different site than the API: session cookies fall back " +
        "to SameSite=None, which forfeits the CSRF protection of plan/21 §3. " +
        "Prefer one registrable domain for both (app./api. subdomains).",
    );
  }

  registerAuthGuard(app, { sessions, users, secureCookies, crossSiteCookies });
  registerAuthRoutes(app, {
    users,
    sessions,
    rateLimiter,
    secureCookies,
    crossSiteCookies,
  });

  const fyersAppId = process.env["FYERS_APP_ID"];
  const fyersAppSecret = process.env["FYERS_APP_SECRET"];
  const fyersRedirectUrl = process.env["FYERS_REDIRECT_URL"];
  if (fyersAppId && fyersAppSecret && fyersRedirectUrl) {
    registerFyersAuthRoutes(app, {
      fyersAppId,
      fyersAppSecret,
      fyersRedirectUrl,
      dashboardOrigin: required("DASHBOARD_ORIGIN"),
      brokerTokens: new BrokerTokensRepository(
        db,
        required("TOKEN_ENCRYPTION_KEY"),
      ),
    });
  }

  registerFyersWebhookRoutes(app, {
    secret: process.env["FYERS_WEBHOOK_SECRET"],
    deliver: async (event) => {
      // Same inbox the dedicated edge function writes, built from the shared
      // key builders (plan/25 §3 bans hand-assembled keys). Registering the
      // route here too means /webhooks/fyers works on either path.
      const record = JSON.stringify(event);
      const inbox = webhookInboxKey("fyers");
      await redis
        .multi()
        .lpush(inbox, record)
        .ltrim(inbox, 0, WEBHOOK_INBOX_MAX - 1)
        .publish(webhookChannel("fyers"), record)
        .exec();
    },
  });

  registerControlPlane(app, {
    db,
    runtime,
    verifyStepUp: createStepUpVerifier(users),
  });

  // Settings must exist before the first read; getGlobal seeds the defaults.
  await new SettingsRepository(db).getGlobal();

  await app.ready();
  return { app, refresh: (now) => runtime.refresh(now) };
}

/**
 * The cached app for this function instance. Concurrent cold-start callers
 * share one in-flight build rather than each opening their own Mongo pool.
 */
let building: Promise<Cached> | undefined;
export async function getApp(): Promise<ApiServer> {
  if (cached !== undefined) return cached.app;
  building ??= build().then(
    (result) => {
      cached = result;
      building = undefined;
      return result;
    },
    (error: unknown) => {
      // Never cache a failed build — the next request must retry from scratch.
      building = undefined;
      throw error;
    },
  );
  return (await building).app;
}
