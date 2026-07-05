import { z } from "zod";

/**
 * Environment configuration — loaded and validated exactly once, at boot,
 * by the composition root (plan/05 §3). The process refuses to start on any
 * failure: a money-moving process must never boot half-configured
 * (plan/04 §6, plan/22 §2). Every variable is documented in `.env.example`.
 *
 * The standing split (MASTER spec §15): environment = infrastructure identity
 * + secrets; the database = trading behavior the operator tunes at runtime
 * (risk limits, the kill flag, daily FYERS tokens are deliberately NOT env).
 */

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // --- HTTP server ---
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /** Browser origin allowed to call the API (CORS + socket handshake). */
    DASHBOARD_ORIGIN: z.string().url().default("http://localhost:3000"),

    // --- Infrastructure ---
    MONGO_URI: z.string().min(1).startsWith("mongodb"),
    REDIS_URL: z.string().min(1).startsWith("redis"),

    // --- Secrets ---
    /** Signs/derives operator session ids (plan/21 §4). */
    SESSION_SECRET: z.string().min(32),
    /**
     * AES-256-GCM key for broker tokens at rest (plan/24 §5) —
     * exactly 32 bytes, hex-encoded. Generate: `openssl rand -hex 32`.
     */
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes hex (64 hex chars)"),

    // --- Broker ---
    /** The composition-root switch (plan/05 §3): Phase 1 = paper, Phase 3 = live. */
    BROKER_MODE: z.enum(["paper", "live"]).default("paper"),
    FYERS_APP_ID: z.string().min(1).optional(),
    FYERS_APP_SECRET: z.string().min(1).optional(),
    FYERS_REDIRECT_URL: z.string().url().optional(),

    // --- Telemetry ---
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  })
  .superRefine((env, ctx) => {
    // The FYERS data feed powers paper trading too (plan/19 §2), but creds are
    // only *hard-required* once the process must talk to FYERS. Live mode
    // without credentials is an unambiguous misconfiguration: refuse to boot.
    if (env.BROKER_MODE === "live") {
      for (const key of [
        "FYERS_APP_ID",
        "FYERS_APP_SECRET",
        "FYERS_REDIRECT_URL",
      ] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when BROKER_MODE=live`,
          });
        }
      }
    }
  });

export type Config = z.infer<typeof EnvSchema>;

/** Thrown when the environment is invalid; lists every problem, not just the first. */
export class ConfigValidationError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    const detail = issues
      .map((issue) => `  - ${issue.path}: ${issue.message}`)
      .join("\n");
    super(`Invalid environment configuration — refusing to start:\n${detail}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Pure loader: env in, validated config out. No process.env access at import
 * time and no caching here — the composition root owns when this runs, and
 * tests fabricate their own env objects.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return result.data;
}
