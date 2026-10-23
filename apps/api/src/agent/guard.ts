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

/**
 * Refuse to run beside a production secret, or without what the agent needs
 * (D5). Throws naming the variables, never their values.
 */
export function assertAgentEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const forbidden = forbiddenIn(env);
  if (forbidden.length > 0)
    throw new Error(
      `refusing to start: the environment holds ${forbidden.join(", ")} — production secrets the research agent must never receive (ADR §13.3). Run it with its own env file, .env.agent.local, holding only ANTHROPIC_API_KEY and MONGO_URI.`,
    );
  const missing = ["ANTHROPIC_API_KEY", "MONGO_URI"].filter(
    (k) => env[k] === undefined || env[k] === "",
  );
  if (missing.length > 0)
    throw new Error(
      `refusing to start: ${missing.join(" and ")} not set — see .env.agent.local.example`,
    );
}

/** Only the research database, or a scratch one (D5). */
export function assertResearchDatabase(name: string): void {
  if (!RESEARCH_DATABASE.test(name))
    throw new Error(
      `refusing "${name}": the research agent reads only neelkanth_research or a scratch neelkanth_it_*/neelkanth_ci_* database`,
    );
}
