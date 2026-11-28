import dns from "node:dns";
import { connectMongo } from "@neelkanth/db";
import { createLogger } from "@neelkanth/logger";
import { buildServer } from "../server.js";
import {
  LearnerScheduler,
  registerLessonResearchRoutes,
} from "../learning/research-routes.js";
import { loadResearchConfig } from "./environment.js";
import { NewsService } from "./news/service.js";
import { registerResearchRoutes } from "./routes.js";

/**
 * The research service's entrypoint (design §6.1 D16; ADR §5.6, §8.1).
 *
 * A separate process from the trading API, on the research database: a
 * plan's odds replay a year of sessions on one thread, and that work must
 * never share an event loop with live ticks and exits. If this process is
 * down, trading is unaffected — the dashboard's research pages say so.
 *
 * Fail-fast, as the trading API is: a bad configuration or a database it may
 * not serve prints and exits before anything connects.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadResearchConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error); // pre-logger
    process.exit(1);
  }
  if (config.dns.length > 0) dns.setServers(config.dns);

  const logger = createLogger({ level: config.logLevel, name: "research-api" });
  const mongo = await connectMongo(config.mongoUri);
  const server = buildServer({
    logger,
    readinessChecks: [
      {
        name: "mongo",
        probe: async () => {
          await mongo.db.command({ ping: 1 });
          return true;
        },
      },
    ],
  });
  registerResearchRoutes(server, {
    db: mongo.db,
    token: config.token,
    now: () => Date.now(),
  });
  // The learning system's judge (PLAN.md 14.27): its verdicts for the
  // trading API's Lessons page, and a run every weekday after the close.
  registerLessonResearchRoutes(server, { db: mongo.db, token: config.token });
  const learner = new LearnerScheduler({
    db: mongo.db,
    onError: (error, context) => {
      logger.warn({ err: error, ...context }, "learner error");
    },
    onRun: (summary) => {
      logger.info(summary, "learner: lessons judged");
    },
  });
  const learnerTimer = setInterval(() => {
    void learner.tick(Date.now());
  }, 60_000);
  learnerTimer.unref();

  // The news and day-context pipeline (operator decision 2026-11-28). Its
  // failures are logged, never fatal: the service's odds and scans do not
  // depend on it. An AI process must never hold a broker or production
  // secret (ADR §13.3) — with one in the environment the morning read is
  // disabled, loudly, and everything else still runs.
  if (config.ai.forbidden.length > 0)
    logger.error(
      { forbidden: config.ai.forbidden },
      `AI MORNING READ DISABLED: ${config.ai.note ?? ""}. Remove these from the research service's environment.`,
    );
  const news = new NewsService({
    db: mongo.db,
    now: () => Date.now(),
    ai: config.ai,
    onError: (error, context) => {
      logger.warn({ err: error, ...context }, "news pipeline error");
    },
    onInfo: (detail, message) => {
      logger.info(detail, message);
    },
  });
  try {
    const added = await news.prepare();
    logger.info({ eventsAdded: added }, "news: calendar loaded");
  } catch (error) {
    logger.error({ err: error }, "news: preparing the collections failed");
  }
  if (config.newsCollector) {
    news.startScheduler();
    logger.info(
      {
        ai: config.ai.ai === null ? config.ai.note : config.ai.ai.provider,
      },
      "news: collector started",
    );
  } else logger.info("news: collector off (NEWS_COLLECTOR=off)");

  let shuttingDown = false;
  const onSignal = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, "shutdown signal received");
      try {
        news.stopScheduler();
        clearInterval(learnerTimer);
        await server.close();
        await mongo.close();
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      }
    })();
  };
  process.on("SIGTERM", () => {
    onSignal("SIGTERM");
  });
  process.on("SIGINT", () => {
    onSignal("SIGINT");
  });

  await server.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port, database: config.database },
    "research api ready",
  );
  // The first judge run after start, once the service is answering.
  void learner.tick(Date.now());
}

main().catch((error: unknown) => {
  console.error("fatal: failed to start", error); // boot failed around logger init
  process.exit(1);
});
