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

/**
 * The path `apps/api` serves the FYERS OAuth callback on. Duplicated here
 * (packages/ may not import apps/, plan/03) so the environment can be checked
 * at boot rather than at the first failed broker login.
 */
const FYERS_CALLBACK_PATH = "/auth/fyers/callback";

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
    /**
     * This API's own public origin. Used only to work out whether the
     * dashboard is a different *site*, which decides SameSite on the session
     * cookie (see apps/api/src/auth/same-site.ts). Unset ⇒ assumed cross-site,
     * because that failure mode costs CSRF hardening while the reverse
     * silently breaks every authenticated request.
     */
    PUBLIC_API_ORIGIN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),

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
    /**
     * Shared secret the FYERS webhook caller must present (plan/21 §4). A
     * broker cannot hold an operator session, so this is what stands between
     * the callback path and the open internet. Optional because FYERS
     * validates a webhook URL by calling it *before* you can configure a
     * secret on it — unset means the path is open, which is a setup state,
     * not a resting state.
     */
    // An empty value is read as unset, not as a zero-length secret: the
    // documented setup order leaves this blank until the URL is registered,
    // and a blank line in `.env` must not become a boot failure.
    FYERS_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(16).optional(),
    ),

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

      // The redirect URL must point at the route that actually exists
      // (apps/api `GET /auth/fyers/callback`). Getting this wrong does not
      // fail at boot on its own — it fails much later, as a broker login that
      // silently never completes, which is the worst possible time to learn
      // about it. Checked in live mode only, where FYERS auth is load-bearing.
      //
      // The path is spelled out here rather than imported: packages/ may not
      // depend on apps/ (plan/03). It is asserted from the route's own side in
      // apps/api's webhook + auth tests, so the two cannot drift silently.
      const redirectUrl = env.FYERS_REDIRECT_URL;
      if (redirectUrl !== undefined) {
        // Pulled apart with a regex rather than `new URL`: this package takes
        // `process.env` as an argument precisely so it depends on nothing but
        // zod — no Node types, no runtime globals. `.url()` above already
        // guarantees the string parses, so the match cannot fail here.
        const path = (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i
          .exec(redirectUrl)?.[1] ?? "").replace(/\/$/, "");
        if (path !== FYERS_CALLBACK_PATH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["FYERS_REDIRECT_URL"],
            message:
              `must end in ${FYERS_CALLBACK_PATH} (the route apps/api serves), ` +
              `got "${path}". It must also be on the API's own origin — the ` +
              `callback needs the operator session cookie — and match the URL ` +
              `registered at myapi.fyers.in byte for byte.`,
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
