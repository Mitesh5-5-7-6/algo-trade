import { rateLimitKey } from "@neelkanth/redis";

/** The Redis subset the limiter needs, as a port (testable with a fake). */
export interface RateLimitKV {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<void>;
}

export interface RateLimitOptions {
  /** Failures within the window before the identifier is locked out. */
  maxFailures: number;
  /** Rolling window the failures are counted over, seconds. */
  windowSeconds: number;
  /** How long a lockout holds once tripped, seconds. */
  lockoutSeconds: number;
}

/**
 * Login throttle + lockout (plan/21 §2). Applied per-account AND per-IP so
 * neither "hammer one account" nor "spray many accounts from one host" slips
 * through. A tripped identifier is locked for `lockoutSeconds`; the counter's
 * TTL extends to the lockout on the failure that trips it, so the lock is
 * self-clearing — no unlock job, no stuck-out operator.
 */
export class LoginRateLimiter {
  constructor(
    private readonly kv: RateLimitKV,
    private readonly options: RateLimitOptions,
  ) {}

  async isLocked(identifier: string): Promise<boolean> {
    const raw = await this.kv.get(rateLimitKey("auth", identifier));
    const count = raw === null ? 0 : Number(raw);
    return count >= this.options.maxFailures;
  }

  /** Record a failed attempt; trips the lockout once the ceiling is reached. */
  async recordFailure(identifier: string): Promise<void> {
    const key = rateLimitKey("auth", identifier);
    const count = await this.kv.incr(key);
    if (count === 1) {
      await this.kv.expire(key, this.options.windowSeconds);
    }
    if (count >= this.options.maxFailures) {
      await this.kv.expire(key, this.options.lockoutSeconds);
    }
  }

  /** Clear the counter on a successful login. */
  async reset(identifier: string): Promise<void> {
    await this.kv.del(rateLimitKey("auth", identifier));
  }
}
