import { Redis } from "ioredis";
import { bootProbeKey } from "./keys.js";

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
  /**
   * For BullMQ workers (plan/08 §6) — and nothing else. A worker parks on
   * blocking commands (BRPOPLPUSH) waiting for a job, so the bounded
   * `maxRetriesPerRequest` the other connections use is not merely wrong here,
   * BullMQ refuses to start with it. It needs its own socket for the same
   * reason the subscriber does: a connection blocked on a job cannot also
   * serve ordinary commands.
   */
  blocking: Redis;
  /** Close all four, cleanly (plan/22 §4 shutdown step). */
  quit(): Promise<void>;
}

/**
 * Called on every connection-level error (e.g. ECONNREFUSED during an outage
 * while ioredis auto-reconnects). Attaching a handler is MANDATORY: an ioredis
 * client with no `error` listener emits an unhandled `error` event, which Node
 * escalates to a process crash. Connection errors are transient by nature, so
 * the composition root logs them at `warn` and lets ioredis reconnect — the
 * readiness probe (plan/23 §4) is what turns a persistent outage into
 * `unready` and halts orders (plan/08 §11).
 */
export type RedisErrorHandler = (
  error: Error,
  source: "client" | "publisher" | "subscriber" | "blocking",
) => void;

export function createRedisConnections(
  url: string,
  onError?: RedisErrorHandler,
): RedisConnections {
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
  // BullMQ validates these and throws at construction if they are wrong
  // (`Your redis options maxRetriesPerRequest must be null`). `null` means
  // "retry forever", which is right for a worker that is *supposed* to sit
  // waiting on an empty queue. The ready check is off because it issues INFO,
  // which managed providers commonly withhold from application users.
  const blocking = new Redis(url, {
    ...options,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  // Always attach a handler — never leave an ioredis `error` event unhandled.
  const handler = onError ?? (() => undefined);
  client.on("error", (error: Error) => {
    handler(error, "client");
  });
  publisher.on("error", (error: Error) => {
    handler(error, "publisher");
  });
  subscriber.on("error", (error: Error) => {
    handler(error, "subscriber");
  });
  blocking.on("error", (error: Error) => {
    handler(error, "blocking");
  });

  return {
    client,
    publisher,
    subscriber,
    blocking,
    async quit() {
      await Promise.allSettled([
        client.quit(),
        publisher.quit(),
        subscriber.quit(),
        blocking.quit(),
      ]);
    },
  };
}

/**
 * A Redis URL safe to put in a log line or an error message: the password is
 * replaced, the host and port kept. The host is the whole point — an operator
 * staring at "connection failed" needs to know *which* Redis, and a redacted
 * URL is the difference between a two-minute fix and an afternoon.
 *
 * Hand-rolled rather than `new URL`, so this stays usable anywhere.
 */
export function redactRedisUrl(url: string): string {
  return url.replace(/^(rediss?:\/\/)([^@/]*)@/i, "$1***@");
}

/** Redis did not answer at boot. Carries the cause, never the password. */
export class RedisUnreachableError extends Error {
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(
      `cannot reach Redis at ${redactRedisUrl(url)}\n` +
        `  - is the host reachable from this machine? a managed Redis is often\n` +
        `    private to one region/account, and a localhost URL never works\n` +
        `    from a deployed container\n` +
        `  - does the provider require TLS? use rediss:// (two s) — plain\n` +
        `    redis:// against a TLS-only endpoint fails exactly like this\n` +
        `  - are the credentials in the URL current?`,
    );
    this.name = "RedisUnreachableError";
  }
}

/**
 * Redis answered, but refused to be written to. Almost always read-only
 * credentials — which PING happily accepts, so nothing earlier catches it.
 */
export class RedisNotWritableError extends Error {
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(
      `Redis at ${redactRedisUrl(url)} answered PING but refused a write.\n` +
        `  The credentials in REDIS_URL are read-only. This system cannot run\n` +
        `  read-only: the session phase, hot prices, risk counters, rate limits\n` +
        `  and operator sessions are all Redis WRITES (plan/08).\n` +
        `  - Upstash: use the database's default credentials, not a read-only\n` +
        `    token and not a read-region endpoint\n` +
        `  - Redis with ACLs: the user needs write access to the key prefixes\n` +
        `    this system owns (hot:, cache:, risk:, session:, ratelimit:,\n` +
        `    jobs:, webhooks:, control:)`,
    );
    this.name = "RedisNotWritableError";
  }
}

/**
 * Prove Redis is usable before the process claims to have started (plan/22 §4).
 *
 * Two checks, because they fail differently and a passing PING proves less than
 * it looks:
 *
 *  1. **Reachable** — otherwise the first command fails somewhere inside engine
 *     wiring as a bare `MaxRetriesPerRequestError`, naming neither the host nor
 *     Redis itself.
 *  2. **Writable** — a read-only user answers PING fine and then rejects the
 *     first `SET` with `NOPERM`, several seconds later, from a stack trace
 *     inside the Redis parser. Every hot path here writes, so read-only access
 *     is not a degraded mode; it is a dead process that has not noticed yet.
 *
 * Mongo is already verified this way at boot (`connectMongo` pings). This is
 * the matching gate, so a money-mover that cannot own its hot state dies
 * immediately and legibly instead of half-started.
 */
export async function verifyRedisConnection(
  connections: Pick<RedisConnections, "client">,
  url: string,
): Promise<void> {
  try {
    await connections.client.ping();
  } catch (error) {
    throw new RedisUnreachableError(url, error);
  }

  // A short TTL on the probe key means even a failure between SET and DEL
  // cleans itself up rather than leaving litter in the keyspace.
  try {
    await connections.client.set(bootProbeKey(), "1", "EX", 10);
    await connections.client.del(bootProbeKey());
  } catch (error) {
    throw new RedisNotWritableError(url, error);
  }
}
