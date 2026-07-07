import Fastify, { type FastifyError } from "fastify";
import type { Logger } from "@neelkanth/logger";
import { isDomainError } from "./errors.js";
import { checkReadiness, type DependencyCheck } from "./health.js";

export interface BuildServerOptions {
  logger: Logger;
  /** The dependency probes readiness aggregates (plan/23 §4). */
  readinessChecks: readonly DependencyCheck[];
}

/**
 * The Fastify server: the control-plane HTTP surface (plan/05). Phase 0 wires
 * only the two health probes and the central error handler; control-plane
 * routes (plan/05 §4.1) land with auth in Phase 1.
 */
export function buildServer(options: BuildServerOptions) {
  const app = Fastify({
    // Reuse our pino logger rather than Fastify's default (plan/23 §3:
    // one structured logger, redaction enforced in its config). Our pino
    // Logger satisfies FastifyBaseLogger directly.
    loggerInstance: options.logger,
    // Trust the reverse proxy in front of us for client IPs (plan/22 §2).
    trustProxy: true,
  });

  // --- Central error handler (plan/05 §5) ---
  // One place maps typed domain errors → status + logs with context, so
  // responses are consistent and nothing fails silently (plan/02 §10).
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isDomainError(error)) {
      request.log.warn(
        { err: error, code: error.code, context: error.context },
        "domain error",
      );
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    // Fastify's own validation errors (schema) → 400.
    if (error.validation) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: error.message },
      });
    }

    // Anything else is unexpected: log full, return an opaque 500. The
    // process stays up (PM2 would restart on a real crash, plan/05 §8).
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });

  // --- Health model (plan/23 §4) ---
  // Both probes are UNAUTHENTICATED (plan/05 §4.1): supervisors call them and
  // they expose no financial state.

  // Liveness: the process responds. Says nothing about dependencies.
  app.get("/health/live", () => ({ status: "live" }));

  // Readiness: can the process do its job? 200 when every dependency is up,
  // 503 otherwise — the supervisor reads this as "don't route/trust", not
  // "restart" (plan/23 §4).
  app.get("/health/ready", async (_request, reply) => {
    const report = await checkReadiness(options.readinessChecks);
    return reply.status(report.ready ? 200 : 503).send({
      status: report.ready ? "ready" : "unready",
      dependencies: report.dependencies,
    });
  });

  return app;
}

/**
 * The concrete server instance type. Inferred (not the default
 * `FastifyInstance`) because our pino logger specializes Fastify's logger
 * generic — consumers hold this type rather than casting.
 */
export type ApiServer = ReturnType<typeof buildServer>;
