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
  source: "client" | "publisher" | "subscriber",
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
 * Prove Redis answers before the process claims to have started (plan/22 §4).
 *
 * Without this the first *command* fails instead — somewhere inside engine
 * wiring, as a bare `MaxRetriesPerRequestError` naming neither the host nor
 * Redis itself. Mongo is already verified this way at boot (`connectMongo`
 * pings); this closes the gap so a money-mover that cannot reach its hot state
 * dies immediately and legibly rather than half-started.
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
}
