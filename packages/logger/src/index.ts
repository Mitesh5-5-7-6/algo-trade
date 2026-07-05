import { pino, type DestinationStream, type Logger } from "pino";

/**
 * The shared structured logger (plan/23 §3): JSON lines, near-zero overhead
 * (this process also runs the tick path, plan/02 §9), one `component` field
 * per subsystem, and `correlationId` on anything pipeline-related.
 *
 * Redaction is enforced HERE, in configuration — never left to call-site
 * discipline (plan/23 §3, plan/24 §5). Secrets listed below are censored in
 * every log line no matter who logs them or how deep they nest.
 */

/** Never logged, ever (plan/23 §3): broker tokens, session ids, password material. */
const REDACT_PATHS = [
  "accessToken",
  "refreshToken",
  "password",
  "passwordHash",
  "sessionId",
  "cookie",
  "authorization",
  "*.accessToken",
  "*.refreshToken",
  "*.password",
  "*.passwordHash",
  "*.sessionId",
  "*.cookie",
  "*.authorization",
  "req.headers.cookie",
  "req.headers.authorization",
] as const;

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface CreateLoggerOptions {
  level: LogLevel;
  /** e.g. "api", "worker" — the process identity on every line. */
  name: string;
  /** Test seam: capture output instead of writing to stdout. */
  destination?: DestinationStream;
}

export type { Logger };

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(
    {
      name: options.name,
      level: options.level,
      redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
      // Level as a readable label — log lines are read by a human during
      // incidents; `"level":30` is one decode step worse than `"level":"info"`.
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    options.destination,
  );
}

/**
 * A component-scoped child logger (`engine.risk`, `broker.fyers`, …) —
 * the component field is what turns a pile of lines into a per-subsystem
 * story (plan/23 §3).
 */
export function componentLogger(base: Logger, component: string): Logger {
  return base.child({ component });
}
