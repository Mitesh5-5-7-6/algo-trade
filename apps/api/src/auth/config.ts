import type { RateLimitOptions } from "./rate-limit.js";

/**
 * Auth tunables (plan/21). Sessions expire two ways: an idle window that slides
 * on activity, and a hard ceiling regardless of activity — a walked-away-from
 * session dies on its own, and even an active one can't live forever.
 */
// 8 h idle (operator decision 2026-11-26, was 30 min): a phone puts the
// browser to sleep, and the operator was signed out through every session.
// The 12 h ceiling and step-up for resume, settings and manual exits stand.
export const SESSION_IDLE_TTL_SECONDS = 8 * 60 * 60;
export const SESSION_ABSOLUTE_MAX_SECONDS = 12 * 60 * 60; // 12 h ceiling

/** Login throttle (plan/21 §2): 5 misses in 15 min → locked out for 15 min. */
export const LOGIN_RATE_LIMIT: RateLimitOptions = {
  maxFailures: 5,
  windowSeconds: 15 * 60,
  lockoutSeconds: 15 * 60,
};
