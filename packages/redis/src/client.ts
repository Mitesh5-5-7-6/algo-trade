import { Redis } from "ioredis";

/**
 * The one place a Redis connection is created (plan/03 §5, Rule 2).
 *
 * Redis Pub/Sub puts a connection into subscriber mode, where regular
 * commands are forbidden — so the bus needs its own connections. This
 * factory hands out purpose-labeled connections; nothing else in the
 * system ever calls `new Redis()`.
 */
export interface RedisConnections {
  /** Commands: cache, hot state, counters. */
  client: Redis;
  /** Dedicated publisher (kept separate so subscriber mode never blocks it). */
  publisher: Redis;
  /** Dedicated subscriber (in subscriber mode; commands forbidden on it). */
  subscriber: Redis;
  /** Close all three, cleanly (plan/22 §4 shutdown step). */
  quit(): Promise<void>;
}

export function createRedisConnections(url: string): RedisConnections {
  const options = {
    // Fail-closed posture (plan/08 §11): commands error out rather than
    // queueing forever against a dead Redis — callers surface the failure.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    lazyConnect: false,
  } as const;

  const client = new Redis(url, options);
  const publisher = new Redis(url, options);
  const subscriber = new Redis(url, options);

  return {
    client,
    publisher,
    subscriber,
    async quit() {
      await Promise.allSettled([
        client.quit(),
        publisher.quit(),
        subscriber.quit(),
      ]);
    },
  };
}
