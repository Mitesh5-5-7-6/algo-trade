/**
 * Namespaced key builders (plan/08 §9). Hand-assembled key strings are
 * banned (plan/25 §3): a typo'd key doesn't error — it silently reads or
 * writes nobody's data. Every key in the system is built here, so the
 * namespace table in plan/08 §9 is enforced by construction.
 */

/** `hot:` — live market snapshot; ephemeral, continuously overwritten (plan/08 §5). */
export const hotPriceKey = (symbol: string) => `hot:price:${symbol}`;
export const hotIndicatorsKey = (symbol: string) => `hot:indicators:${symbol}`;
export const hotSessionKey = () => "hot:session";

/** `cache:` — config/settings cache; TTL + explicit bust on write (plan/08 §4). */
export const cacheEnabledStrategiesKey = () => "cache:strategies:enabled";
export const cacheGlobalSettingsKey = () => "cache:settings:global";

/** `risk:` — the Risk Engine's running counters, per trading day (plan/08 §5). */
export const riskDailyLossKey = (dateIST: string) =>
  `risk:dailyLoss:${dateIST}`;
export const riskOpenCountKey = () => "risk:openCount";

/** `session:` — operator auth sessions; TTL = expiry (plan/08 §7). */
export const authSessionKey = (sessionId: string) => `session:${sessionId}`;
/** The set of a user's live session ids, for revoke-all (plan/21 §4, §7). */
export const authUserSessionsKey = (userId: string) => `session:user:${userId}`;

/** `ratelimit:` — throttle counters; TTL = window (plan/08 §8). */
export const rateLimitKey = (scope: string, key: string) =>
  `ratelimit:${scope}:${key}`;

/** `jobs:` — BullMQ queue names (plan/08 §6); queues arrive with milestone 1.1. */
export const JOB_QUEUES = {
  news: "jobs:news",
  aiSummary: "jobs:ai-summary",
  tokenRefresh: "jobs:token-refresh",
  notifications: "jobs:notifications",
} as const;

/** Market data channels re-exported from contracts for one-import ergonomics. */
export {
  eventChannel,
  marketCandleChannel,
  marketTickChannel,
} from "@neelkanth/contracts";

/**
 * `webhooks:` — raw broker callbacks landing from outside the process
 * (plan/08 §9). The inbox is a capped list, newest first: a webhook is
 * fire-and-forget from the broker's side, so we durably park the delivery the
 * moment we accept it and let the pipeline drain it. The channel carries the
 * same payload for consumers that are already up, per plan/08 §3 (pub/sub is
 * a nudge, the list is the record).
 *
 * NOTE: `apps/api/api/webhooks/*` (the Vercel edge ingest) re-declares these
 * two strings literally. It is bundled outside the workspace graph and cannot
 * import them; the duplication is deliberate and both sides must move together.
 */
export const webhookInboxKey = (source: string) => `webhooks:${source}:inbox`;
export const webhookChannel = (source: string) => `webhooks:${source}`;
/** How many raw deliveries the inbox retains before dropping the oldest. */
export const WEBHOOK_INBOX_MAX = 1000;
