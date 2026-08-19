import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  redactRedisUrl,
  RedisUnreachableError,
  verifyRedisConnection,
} from "./client.js";

/** Just enough of a client to answer (or refuse) a PING. */
function fakeClient(ping: () => Promise<string>): Pick<Redis, "ping"> {
  return { ping } as Pick<Redis, "ping">;
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
  it("resolves when Redis answers", async () => {
    await expect(
      verifyRedisConnection(
        { client: fakeClient(() => Promise.resolve("PONG")) as Redis },
        "redis://localhost:6379",
      ),
    ).resolves.toBeUndefined();
  });

  it("throws a named error that says WHICH Redis failed", async () => {
    const url = "redis://default:hunter2@my-redis.example.com:6379";
    await expect(
      verifyRedisConnection(
        {
          client: fakeClient(() =>
            Promise.reject(new Error("MaxRetriesPerRequestError")),
          ) as Redis,
        },
        url,
      ),
    ).rejects.toThrow(RedisUnreachableError);
  });

  it("names the host and the TLS trap, and never the password", async () => {
    const url = "redis://default:hunter2@my-redis.example.com:6379";
    try {
      await verifyRedisConnection(
        {
          client: fakeClient(() => Promise.reject(new Error("boom"))) as Redis,
        },
        url,
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("my-redis.example.com:6379");
      expect(message).toContain("rediss://");
      expect(message).not.toContain("hunter2");
    }
  });

  it("keeps the original failure as the cause", async () => {
    const cause = new Error("ECONNREFUSED");
    try {
      await verifyRedisConnection(
        { client: fakeClient(() => Promise.reject(cause)) as Redis },
        "redis://localhost:6379",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as RedisUnreachableError).cause).toBe(cause);
    }
  });
});
