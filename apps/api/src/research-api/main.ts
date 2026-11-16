import dns from "node:dns";
import { connectMongo } from "@neelkanth/db";
import { createLogger } from "@neelkanth/logger";
import { buildServer } from "../server.js";
import { loadResearchConfig } from "./environment.js";
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

  let shuttingDown = false;
  const onSignal = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, "shutdown signal received");
      try {
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
}

main().catch((error: unknown) => {
  console.error("fatal: failed to start", error); // boot failed around logger init
  process.exit(1);
});
