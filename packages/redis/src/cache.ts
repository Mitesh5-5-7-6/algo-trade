import type { Redis } from "ioredis";
import type { z } from "zod";

/**
 * JSON cache helpers with schema-validated reads (plan/08 §4).
 *
 * Reads parse through the caller's Zod schema — a corrupted or stale-shaped
 * cache entry is treated as a MISS, never returned as trusted data. Writes
 * carry a TTL as the safety net; correctness comes from explicit busting on
 * the owning write path (plan/08 §4: stale config is dangerous).
 */
export async function cacheGetJson<S extends z.ZodTypeAny>(
  redis: Redis,
  key: string,
  schema: S,
): Promise<z.infer<S> | undefined> {
  const raw = await redis.get(key);
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await redis.del(key); // corrupted entry: self-heal by removing it
    return undefined;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    await redis.del(key);
    return undefined;
  }
  return result.data as z.infer<S>;
}

export async function cacheSetJson(
  redis: Redis,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
}

/** Explicit invalidation — part of every owning write (plan/08 §4). */
export async function cacheBust(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}
