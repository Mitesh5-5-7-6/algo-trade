import { describe, expect, it } from "vitest";
import { LoginRateLimiter, type RateLimitKV } from "./rate-limit.js";

/** In-memory RateLimitKV. TTLs are recorded, not enforced (that's Redis's job). */
function fakeKV(): RateLimitKV & { ttls: Map<string, number> } {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    ttls,
    incr(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve(next);
    },
    get(key) {
      const v = counts.get(key);
      return Promise.resolve(v === undefined ? null : String(v));
    },
    expire(key, ttlSeconds) {
      ttls.set(key, ttlSeconds);
      return Promise.resolve();
    },
    ttl(key) {
      return Promise.resolve(ttls.get(key) ?? -2);
    },
    del(key) {
      counts.delete(key);
      ttls.delete(key);
      return Promise.resolve();
    },
  };
}

const OPTIONS = { maxFailures: 5, windowSeconds: 900, lockoutSeconds: 1800 };

describe("LoginRateLimiter (plan/21 §2)", () => {
  it("does not lock before the ceiling", async () => {
    const limiter = new LoginRateLimiter(fakeKV(), OPTIONS);
    for (let i = 0; i < 4; i++) await limiter.recordFailure("me@x.io");
    expect(await limiter.isLocked("me@x.io")).toBe(false);
  });

  it("locks once the failure ceiling is reached", async () => {
    const limiter = new LoginRateLimiter(fakeKV(), OPTIONS);
    for (let i = 0; i < 5; i++) await limiter.recordFailure("me@x.io");
    expect(await limiter.isLocked("me@x.io")).toBe(true);
  });

  it("sets the window TTL on first failure and the lockout TTL on the trip", async () => {
    const kv = fakeKV();
    const limiter = new LoginRateLimiter(kv, OPTIONS);
    await limiter.recordFailure("me@x.io");
    expect(kv.ttls.get("ratelimit:auth:me@x.io")).toBe(900);
    for (let i = 0; i < 4; i++) await limiter.recordFailure("me@x.io");
    expect(kv.ttls.get("ratelimit:auth:me@x.io")).toBe(1800);
  });

  it("reset clears the lock (successful login)", async () => {
    const limiter = new LoginRateLimiter(fakeKV(), OPTIONS);
    for (let i = 0; i < 5; i++) await limiter.recordFailure("me@x.io");
    await limiter.reset("me@x.io");
    expect(await limiter.isLocked("me@x.io")).toBe(false);
  });

  it("tracks identifiers independently (per-account vs per-IP)", async () => {
    const limiter = new LoginRateLimiter(fakeKV(), OPTIONS);
    for (let i = 0; i < 5; i++) await limiter.recordFailure("1.2.3.4");
    expect(await limiter.isLocked("1.2.3.4")).toBe(true);
    expect(await limiter.isLocked("me@x.io")).toBe(false);
  });
});
