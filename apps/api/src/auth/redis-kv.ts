import type { Redis } from "ioredis";
import type { SessionKV } from "./sessions.js";
import type { RateLimitKV } from "./rate-limit.js";

/**
 * The composition-root adapters that back the auth ports (plan/05 §3) with the
 * real Redis client. The stores themselves speak the small `SessionKV` /
 * `RateLimitKV` interfaces so they stay unit-testable with in-memory fakes;
 * this is the one place ioredis is spoken to.
 */
export function redisSessionKV(client: Redis): SessionKV {
  return {
    async set(key, value, ttlSeconds) {
      await client.set(key, value, "EX", ttlSeconds);
    },
    get: (key) => client.get(key),
    async del(key) {
      await client.del(key);
    },
    async sadd(key, member) {
      await client.sadd(key, member);
    },
    async srem(key, member) {
      await client.srem(key, member);
    },
    smembers: (key) => client.smembers(key),
  };
}

export function redisRateLimitKV(client: Redis): RateLimitKV {
  return {
    incr: (key) => client.incr(key),
    get: (key) => client.get(key),
    async expire(key, ttlSeconds) {
      await client.expire(key, ttlSeconds);
    },
    ttl: (key) => client.ttl(key),
    async del(key) {
      await client.del(key);
    },
  };
}
