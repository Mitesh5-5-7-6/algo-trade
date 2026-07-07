import { loadConfig, ConfigValidationError } from "@neelkanth/config";
import { createLogger } from "@neelkanth/logger";
import { bootstrap } from "./composition-root.js";

/**
 * The process entrypoint (plan/05 §3, plan/22 §4).
 *
 * Fail-fast on bad config: a half-configured money-mover must never boot
 * (plan/04 §6). Config errors print and exit non-zero *before* any infra is
 * touched. On a clean boot, SIGTERM/SIGINT trigger the graceful shutdown
 * sequence (plan/22 §4).
 */
async function main(): Promise<void> {
  // Config first — validated before the logger, so even a bad-config death
  // is legible. process.env is read HERE (the one edge), not in the loader.
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(error.message); // pre-logger boot failure: stderr is all we have
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.LOG_LEVEL, name: "api" });
  const context = await bootstrap(config, logger);

  let shuttingDown = false;
  const onSignal = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, "shutdown signal received");
      try {
        await context.shutdown();
        logger.info("shutdown complete");
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

  await context.server.listen({
    host: config.API_HOST,
    port: config.API_PORT,
  });
  logger.info(
    { host: config.API_HOST, port: config.API_PORT, mode: config.BROKER_MODE },
    "api ready",
  );
}

// Top-level: any boot failure is fatal and must be loud (plan/05 §8).
main().catch((error: unknown) => {
  console.error("fatal: failed to start", error); // boot failed around logger init
  process.exit(1);
});
