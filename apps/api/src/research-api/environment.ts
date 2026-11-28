import { z } from "zod";
import { forbiddenIn } from "../agent/guard.js";

/**
 * The research service's own environment (design §6.1 D16).
 *
 * Deliberately not `@neelkanth/config`: that schema describes the trading
 * process — broker mode, FYERS, Redis, sessions — and the research service
 * has none of them. It needs a database, a port and one shared secret.
 */

/** The research database, or a scratch one. Nothing else (ADR §8.1). */
const RESEARCH_DATABASE = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;

/**
 * Why this database may not be served, or null when it may.
 *
 * The same rule the research CLIs start under. A research service pointed at
 * a paper or Live database would read trading state as if it were research
 * data, and keep its runs beside real orders.
 */
export function researchDatabaseProblem(name: string): string | null {
  return RESEARCH_DATABASE.test(name)
    ? null
    : `refusing "${name}": the research service reads and writes only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database`;
}

/** The database a MongoDB URI names, without connecting; "" when it names none. */
export function databaseNameOf(uri: string): string {
  const path = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^?#]*)/.exec(uri)?.[1] ?? "";
  return decodeURIComponent(path);
}

const empty = (value: unknown): unknown => (value === "" ? undefined : value);

/**
 * The morning read's model (operator decision 2026-11-28), all optional: a
 * provider the research agent's OpenAI-compatible client speaks, the model —
 * required once a provider is named, there is no default — and that
 * provider's key. Without a provider or its key the read is skipped and the
 * day context says so.
 */
const AI_PROVIDERS = ["openai", "deepseek", "gemini"] as const;
const AI_KEY: Record<(typeof AI_PROVIDERS)[number], string> = {
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
};
const AiEnvShape = {
  AGENT_PROVIDER: z.preprocess(empty, z.enum(AI_PROVIDERS).optional()),
  AGENT_MODEL: z.preprocess(empty, z.string().min(1).optional()),
  OPENAI_API_KEY: z.preprocess(empty, z.string().optional()),
  DEEPSEEK_API_KEY: z.preprocess(empty, z.string().optional()),
  GEMINI_API_KEY: z.preprocess(empty, z.string().optional()),
};
const requireModel = (
  e: { AGENT_PROVIDER?: string | undefined; AGENT_MODEL?: string | undefined },
  ctx: z.RefinementCtx,
): void => {
  if (e.AGENT_PROVIDER !== undefined && e.AGENT_MODEL === undefined)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AGENT_MODEL"],
      message: "required when AGENT_PROVIDER is set",
    });
};
const AiEnvSchema = z.object(AiEnvShape).superRefine(requireModel);
type AiEnv = z.infer<typeof AiEnvSchema>;

export interface ResearchAiConfig {
  provider: (typeof AI_PROVIDERS)[number];
  model: string;
  /** Held in memory for the client only; never logged, never kept. */
  apiKey: string;
}

export interface ResearchAi {
  /** Null when the morning read may not run. */
  ai: ResearchAiConfig | null;
  /** Why it may not, for the day context's notes; null when it may. */
  note: string | null;
  /**
   * Broker or production secrets present in the environment — names only.
   * Any one disables the read (ADR §13.3): an AI process must never hold them.
   */
  forbidden: string[];
}

function resolveAi(e: AiEnv, forbidden: string[]): ResearchAi {
  if (forbidden.length > 0)
    return {
      ai: null,
      note: `AI read disabled: the environment holds ${forbidden.join(", ")}, secrets an AI process must never hold (ADR §13.3)`,
      forbidden,
    };
  if (e.AGENT_PROVIDER === undefined || e.AGENT_MODEL === undefined)
    return { ai: null, note: "no AI key configured", forbidden };
  const keyName = AI_KEY[e.AGENT_PROVIDER];
  const apiKey = {
    openai: e.OPENAI_API_KEY,
    deepseek: e.DEEPSEEK_API_KEY,
    gemini: e.GEMINI_API_KEY,
  }[e.AGENT_PROVIDER];
  if (apiKey === undefined)
    return {
      ai: null,
      note: `no AI key configured (${keyName} is not set)`,
      forbidden,
    };
  return {
    ai: { provider: e.AGENT_PROVIDER, model: e.AGENT_MODEL, apiKey },
    note: null,
    forbidden,
  };
}

const invalid = (issues: z.ZodIssue[]): Error =>
  new Error(
    `research service configuration is invalid:\n${issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")}`,
  );

/**
 * The morning read's model from an environment, alone — for the news CLI,
 * which holds no service token. Throws on a malformed provider or a provider
 * without a model; a missing key or a forbidden secret is a note, not an error.
 */
export function loadResearchAi(
  env: Record<string, string | undefined>,
): ResearchAi {
  const parsed = AiEnvSchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error.issues);
  return resolveAi(parsed.data, forbiddenIn(env));
}

const EnvSchema = z
  .object({
    MONGO_URI: z.string().min(1).startsWith("mongodb"),
    /**
     * The secret the trading API presents when it relays an operator's request.
     * Long, because it is the only thing between the internet and the service.
     */
    RESEARCH_API_TOKEN: z.string().min(32),
    RESEARCH_API_HOST: z.preprocess(empty, z.string().min(1).optional()),
    RESEARCH_API_PORT: z.preprocess(
      empty,
      z.coerce.number().int().min(1).max(65535).optional(),
    ),
    /** A PaaS's port convention: bind it, on every interface (plan/22 §2). */
    PORT: z.preprocess(
      empty,
      z.coerce.number().int().min(1).max(65535).optional(),
    ),
    /** Resolvers for a `mongodb+srv` lookup the local resolver refuses. */
    RESEARCH_DNS: z.preprocess(empty, z.string().optional()),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    /** `off` stops the news collector and the morning jobs; on by default. */
    NEWS_COLLECTOR: z.preprocess(empty, z.enum(["on", "off"]).optional()),
    ...AiEnvShape,
  })
  .superRefine(requireModel);

export interface ResearchApiConfig {
  mongoUri: string;
  database: string;
  token: string;
  host: string;
  port: number;
  dns: string[];
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  /** The news collector, overnight fetch and morning read run (default). */
  newsCollector: boolean;
  /** The morning read's model, or why there is none. */
  ai: ResearchAi;
}

/**
 * Read and check the environment. Throws one error naming every problem —
 * and refuses the database by its name, here, before anything connects.
 */
export function loadResearchConfig(
  env: Record<string, string | undefined>,
): ResearchApiConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const e = parsed.data;
  const database = databaseNameOf(e.MONGO_URI);
  const problem = researchDatabaseProblem(database);
  if (problem !== null) throw new Error(problem);
  return {
    mongoUri: e.MONGO_URI,
    database,
    token: e.RESEARCH_API_TOKEN,
    // PORT set means a container the platform reaches from outside.
    host:
      e.RESEARCH_API_HOST ?? (e.PORT === undefined ? "127.0.0.1" : "0.0.0.0"),
    port: e.RESEARCH_API_PORT ?? e.PORT ?? 4100,
    dns: (e.RESEARCH_DNS ?? "").split(",").filter(Boolean),
    logLevel: e.LOG_LEVEL,
    newsCollector: e.NEWS_COLLECTOR !== "off",
    ai: resolveAi(e, forbiddenIn(env)),
  };
}
