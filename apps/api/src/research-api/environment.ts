import { z } from "zod";

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

const EnvSchema = z.object({
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
});

export interface ResearchApiConfig {
  mongoUri: string;
  database: string;
  token: string;
  host: string;
  port: number;
  dns: string[];
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
}

/**
 * Read and check the environment. Throws one error naming every problem —
 * and refuses the database by its name, here, before anything connects.
 */
export function loadResearchConfig(
  env: Record<string, string | undefined>,
): ResearchApiConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `research service configuration is invalid:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
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
  };
}
