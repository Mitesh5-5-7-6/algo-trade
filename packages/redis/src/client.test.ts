import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createRedisConnections } from "./client.js";
import {
  redactRedisUrl,
  RedisNotWritableError,
  RedisUnreachableError,
  verifyRedisConnection,
} from "./client.js";

/** Just enough of a client for the boot probe: a PING and a SET/DEL pair. */
function fakeClient(options: {
  ping?: () => Promise<string>;
  set?: () => Promise<"OK">;
}): Redis {
  return {
    ping: options.ping ?? (() => Promise.resolve("PONG")),
    set: options.set ?? (() => Promise.resolve("OK")),
    del: () => Promise.resolve(1),
  } as unknown as Redis;
}

describe("redactRedisUrl", () => {
  it("removes the password but keeps the host — the host is the diagnosis", () => {
    expect(redactRedisUrl("redis://default:hunter2@my-redis.example.com:6379")).toBe(
      "redis://***@my-redis.example.com:6379",
    );
  });

  it("redacts a bare password with no username", () => {
    expect(redactRedisUrl("rediss://:s3cret@host:6380")).toBe(
      "rediss://***@host:6380",
    );
  });

  it("leaves a credential-free URL untouched", () => {
    expect(redactRedisUrl("redis://localhost:6379")).toBe(
      "redis://localhost:6379",
    );
  });

  it("handles rediss:// as well as redis://", () => {
    expect(redactRedisUrl("rediss://u:p@a.upstash.io:6379")).toBe(
      "rediss://***@a.upstash.io:6379",
    );
  });

  it("never leaks the secret, whatever the shape", () => {
    const redacted = redactRedisUrl("redis://user:p%40ss:word@host:6379/0");
    expect(redacted).not.toContain("word");
    expect(redacted).not.toContain("p%40ss");
  });
});

describe("verifyRedisConnection (plan/22 §4: die legibly, not late)", () => {
  const URL_WITH_SECRET = "redis://default:hunter2@my-redis.example.com:6379";

  it("resolves when Redis answers and accepts a write", async () => {
    await expect(
      verifyRedisConnection(
        { client: fakeClient({}) },
        "redis://localhost:6379",
      ),
    ).resolves.toBeUndefined();
  });

  it("throws RedisUnreachableError when PING fails", async () => {
    await expect(
      verifyRedisConnection(
        {
          client: fakeClient({
            ping: () => Promise.reject(new Error("MaxRetriesPerRequestError")),
          }),
        },
        URL_WITH_SECRET,
      ),
    ).rejects.toThrow(RedisUnreachableError);
  });

  it("names the host and the TLS trap, and never the password", async () => {
    try {
      await verifyRedisConnection(
        { client: fakeClient({ ping: () => Promise.reject(new Error("boom")) }) },
        URL_WITH_SECRET,
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("my-redis.example.com:6379");
      expect(message).toContain("rediss://");
      expect(message).not.toContain("hunter2");
    }
  });

  it("catches read-only credentials that PING alone would wave through", async () => {
    // Exactly the Upstash/ACL case: PING is permitted, SET is NOPERM. Without
    // the write probe this passes boot and dies seconds later inside the
    // engines, in a stack trace from the Redis parser.
    await expect(
      verifyRedisConnection(
        {
          client: fakeClient({
            set: () =>
              Promise.reject(
                new Error(
                  "NOPERM this user has no permissions to run the 'set' command",
                ),
              ),
          }),
        },
        URL_WITH_SECRET,
      ),
    ).rejects.toThrow(RedisNotWritableError);
  });

  it("says read-only plainly, and still never leaks the password", async () => {
    try {
      await verifyRedisConnection(
        {
          client: fakeClient({
            set: () => Promise.reject(new Error("NOPERM")),
          }),
        },
        URL_WITH_SECRET,
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("read-only");
      expect(message).toContain("my-redis.example.com:6379");
      expect(message).not.toContain("hunter2");
    }
  });

  it("keeps the original failure as the cause", async () => {
    const cause = new Error("ECONNREFUSED");
    try {
      await verifyRedisConnection(
        { client: fakeClient({ ping: () => Promise.reject(cause) }) },
        "redis://localhost:6379",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as RedisUnreachableError).cause).toBe(cause);
    }
  });
});

describe("createRedisConnections (plan/03 §5: the only place Redis is opened)", () => {
  // Never connects: an unroutable port fails instantly and the error handler
  // swallows it, which is enough to read back the options each socket was
  // constructed with.
  const URL = "redis://127.0.0.1:1";

  it("gives BullMQ a connection with unbounded retries", async () => {
    // BullMQ THROWS at worker construction on anything else:
    // "Your redis options maxRetriesPerRequest must be null". A worker parks
    // on a blocking command waiting for a job, so a bounded retry is wrong.
    const conns = createRedisConnections(URL, () => undefined);
    try {
      expect(conns.blocking.options.maxRetriesPerRequest).toBeNull();
      expect(conns.blocking.options.enableReadyCheck).toBe(false);
    } finally {
      await conns.quit();
    }
  });

  it("keeps the command connections fail-closed (plan/08 §11)", async () => {
    // The opposite posture: ordinary commands must surface a dead Redis as an
    // error rather than hanging on it forever.
    const conns = createRedisConnections(URL, () => undefined);
    try {
      expect(conns.client.options.maxRetriesPerRequest).toBe(2);
      expect(conns.publisher.options.maxRetriesPerRequest).toBe(2);
      expect(conns.subscriber.options.maxRetriesPerRequest).toBe(2);
    } finally {
      await conns.quit();
    }
  });

  it("gives the worker its own socket, not the shared client", async () => {
    // Sharing would let a worker blocked on BRPOPLPUSH stall every other
    // command queued behind it.
    const conns = createRedisConnections(URL, () => undefined);
    try {
      expect(conns.blocking).not.toBe(conns.client);
      expect(conns.blocking).not.toBe(conns.subscriber);
    } finally {
      await conns.quit();
    }
  });

  it("labels blocking-connection errors so an outage names the right socket", async () => {
    const sources: string[] = [];
    const conns = createRedisConnections(URL, (_error, source) => {
      sources.push(source);
    });
    try {
      conns.blocking.emit("error", new Error("boom"));
      expect(sources).toContain("blocking");
    } finally {
      await conns.quit();
    }
  });
});
