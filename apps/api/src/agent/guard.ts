/**
 * What the agent's environment must not hold (D5; ADR §13.3, §23 rules 7
 * and 9): broker credentials, the session and token secrets, the operator's
 * login, and the trading runtime's Redis. Their presence means the agent was
 * launched with a trading env file — refused before anything connects.
 */
const FORBIDDEN: readonly RegExp[] = [
  /^FYERS_/,
  /^TOKEN_ENCRYPTION_KEY$/,
  /^SESSION_SECRET$/,
  /^NEELKANTH_OPERATOR_/,
  /^REDIS_URL$/,
  /^BROKER_MODE$/,
];

/** The databases the agent may read and keep its answers in. */
const RESEARCH_DATABASE = /^(neelkanth_research|neelkanth_(it|ci)_.+)$/;

/** The names — never the values — of forbidden variables that are set. */
export function forbiddenIn(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== "")
    .filter((k) => FORBIDDEN.some((r) => r.test(k)))
    .sort();
}

/** The providers the agent can run on (design Q1 revised, D8). */
export const PROVIDERS = ["anthropic", "openai", "deepseek", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Each provider's key, and whether the operator must name the model. */
const NEEDS: Record<Provider, { key: string; model: boolean }> = {
  anthropic: { key: "ANTHROPIC_API_KEY", model: false },
  openai: { key: "OPENAI_API_KEY", model: true },
  deepseek: { key: "DEEPSEEK_API_KEY", model: true },
  gemini: { key: "GEMINI_API_KEY", model: true },
};

export interface AgentEnvironment {
  provider: Provider;
  /** The provider's key variable — its name; the value stays in the env. */
  keyVariable: string;
  /** The model the operator named; undefined means the provider's default (Anthropic only). */
  model: string | undefined;
}

/**
 * Refuse to run beside a production secret, or without what the agent needs
 * (D5): the provider (`AGENT_PROVIDER`, default anthropic), its key, the model
 * when the provider has no default of ours (D8), and `MONGO_URI`. Throws
 * naming the variables, never their values.
 */
export function assertAgentEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): AgentEnvironment {
  const forbidden = forbiddenIn(env);
  if (forbidden.length > 0)
    throw new Error(
      `refusing to start: the environment holds ${forbidden.join(", ")} — production secrets the research agent must never receive (ADR §13.3). Run it with its own env file, .env.agent.local, holding only the provider's key, the model and MONGO_URI.`,
    );
  const named = env["AGENT_PROVIDER"] ?? "";
  const provider = (named === "" ? "anthropic" : named) as Provider;
  if (!PROVIDERS.includes(provider))
    throw new Error(
      `refusing to start: AGENT_PROVIDER "${named}" is none of ${PROVIDERS.join(", ")}`,
    );
  const need = NEEDS[provider];
  const set = (k: string) => env[k] !== undefined && env[k] !== "";
  const missing = [
    need.key,
    ...(need.model ? ["AGENT_MODEL"] : []),
    "MONGO_URI",
  ].filter((k) => !set(k));
  if (missing.length > 0)
    throw new Error(
      `refusing to start: ${missing.join(" and ")} not set — see .env.agent.local.example`,
    );
  return {
    provider,
    keyVariable: need.key,
    model: set("AGENT_MODEL") ? env["AGENT_MODEL"] : undefined,
  };
}

/** Only the research database, or a scratch one (D5). */
export function assertResearchDatabase(name: string): void {
  if (!RESEARCH_DATABASE.test(name))
    throw new Error(
      `refusing "${name}": the research agent reads only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database`,
    );
}
