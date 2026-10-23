import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cacheBust,
  cacheGetJson,
  cacheSetJson,
  createEventBus,
  createRedisConnections,
  hotPriceKey,
  rateLimitKey,
  riskDailyLossKey,
  type EventBus,
  type RedisConnections,
} from "./index.js";

/**
 * Integration tests against REAL Redis (plan/27 §2), run by the CI service
 * container. No mocks — the event relay test is the license for the whole
 * Regime B design.
 *
 * When Redis is unreachable (local dev provides no Redis) the infra tests
 * SKIP rather than fail; in CI the service container is always present, so
 * there they run and gate. The pure key-builder test always runs.
 */
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

let connections: RedisConnections | undefined;
let bus: EventBus | undefined;
let redisAvailable = false;
const busErrors: unknown[] = [];

/**
 * Wait until `ready()` holds, or give up.
 *
 * Replaces a fixed `setTimeout(300)`. Pub/sub delivery took well under 300ms
 * against a local container, and does not against a hosted instance across a
 * region — so the sleep was not a wait, it was a bet on latency. Polling is
 * correct at any latency and returns as soon as the event lands, so the fast
 * case stays fast.
 */
async function until(
  ready: () => boolean,
  ms = 15_000,
  step = 25,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

/** Reject if `promise` doesn't settle within `ms` — ping can hang when down. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => {
        reject(new Error("timeout"));
      }, ms),
    ),
  ]);
}

beforeAll(async () => {
  const conn = createRedisConnections(REDIS_URL);
  try {
    // 2 seconds was enough when the only Redis anyone ran this against was a
    // local container. A hosted instance adds a TLS handshake and real network
    // latency — Upstash in ap-south-1 does not reliably answer inside two
    // seconds on a first connect — and the suite then reported "unreachable"
    // for an instance that a direct PING answers fine.
    await withTimeout(conn.client.ping(), 15_000);
    redisAvailable = true;
    connections = conn;
    // `redisEvents` must name the events that actually travel over Redis.
    // It is empty by default — and honestly so, because in production one
    // process holds the whole chain and a round trip to Upstash and back was
    // ~96% of all Redis commands. But an integration suite that leaves it
    // empty is not testing Redis at all: `subscribe` returns before issuing
    // SUBSCRIBE and `publish` dispatches in-process, so the relay test was a
    // pure in-memory round trip and the malformed-message test published into
    // a channel nobody was listening on. Naming the event here is what makes
    // this file exercise the path it claims to.
    bus = createEventBus(
      conn.publisher,
      conn.subscriber,
      (error) => {
        busErrors.push(error);
      },
      { redisEvents: ["ORDER_FILLED"] },
    );
  } catch (error) {
    redisAvailable = false;
    await conn.quit().catch(() => undefined);

    // Previously this skipped in silence, which is the half of the problem
    // §0.4 exists to fix: a suite that never ran and a suite that passed both
    // reported `0 failed`.
    const reason = error instanceof Error ? error.message : String(error);
    if (process.env["REQUIRE_INTEGRATION"] === "1") {
      throw new Error(
        `redis.integration.test.ts: Redis unreachable and ` +
          `REQUIRE_INTEGRATION=1 — ${reason}`,
      );
    }
    const line = "#".repeat(74);
    process.stderr.write(
      `\n${line}\n` +
        `INTEGRATION SUITE NOT RUN — packages/redis/src/redis.integration.test.ts\n` +
        `  These tests were NOT EXECUTED. Skipped is not passed.\n` +
        `  reason : ${reason}\n` +
        `  target : ${REDIS_URL.replace(/\/\/[^@/]*@/, "//<credentials>@")}\n` +
        `  fix    : docker compose -f docker-compose.test.yml up -d\n` +
        `  strict : run \`pnpm test:integration\` to make this a hard failure\n` +
        `${line}\n\n`,
    );
  }
});

afterAll(async () => {
  if (bus) await bus.close();
  if (connections) await connections.quit();
});

/** Skip the calling test when Redis isn't reachable; else assert we have it. */
function requireRedis(ctx: { skip: () => void }): {
  connections: RedisConnections;
  bus: EventBus;
} {
  if (!redisAvailable || !connections || !bus) {
    ctx.skip();
    throw new Error("unreachable"); // ctx.skip() aborts; satisfies types
  }
  return { connections, bus };
}

describe("key builders (plan/08 §9)", () => {
  it("produce namespace-prefixed keys", () => {
    expect(hotPriceKey("NSE:INFY-EQ")).toBe("hot:price:NSE:INFY-EQ");
    expect(riskDailyLossKey("2026-07-05")).toBe("risk:dailyLoss:2026-07-05");
    expect(rateLimitKey("broker", "orders")).toBe("ratelimit:broker:orders");
  });
});

describe("event bus (plan/09)", () => {
  it("round-trips a validated ORDER_FILLED to a subscriber", async (ctx) => {
    const { bus } = requireRedis(ctx);
    const received: unknown[] = [];
    await bus.subscribe("ORDER_FILLED", (event) => {
      received.push(event);
    });

    await bus.publish(
      "ORDER_FILLED",
      {
        orderId: "ord_it_1",
        strategyId: "str_it_1",
        symbol: "NSE:INFY-EQ",
        side: "BUY",
        qty: 10,
        filledPrice: 1500.5,
        slippage: 0.3,
        charges: 12.4,
        filledAt: Date.now(),
        mode: "paper",
        ts: Date.now(),
      },
      "sig_it_1",
    );

    await until(() => received.length >= 1);
    expect(received).toHaveLength(1);
    const event = received[0] as {
      name: string;
      correlationId?: string;
      payload: { orderId: string };
    };
    expect(event.name).toBe("ORDER_FILLED");
    expect(event.correlationId).toBe("sig_it_1");
    expect(event.payload.orderId).toBe("ord_it_1");
  });

  it("refuses to publish a malformed payload (producer-side boundary)", async (ctx) => {
    const { bus } = requireRedis(ctx);
    await expect(
      bus.publish("ORDER_FILLED", {
        orderId: "ord_bad",
        strategyId: "str_it_1",
        symbol: "NSE:INFY-EQ",
        side: "BUY",
        qty: -5, // type-valid number, runtime-invalid: Zod rejects at the boundary
        filledPrice: 1500,
        slippage: 0,
        charges: 0,
        filledAt: Date.now(),
        mode: "paper",
        ts: Date.now(),
      }),
    ).rejects.toThrow();
  });

  it("surfaces malformed wire messages to onError, never to handlers", async (ctx) => {
    const { connections } = requireRedis(ctx);
    const before = busErrors.length;
    await connections.publisher.publish(
      "events:ORDER_FILLED",
      "{not json at all",
    );
    await until(() => busErrors.length > before);
    expect(busErrors.length).toBeGreaterThan(before);
  });
});

describe("cache helpers (plan/08 §4)", () => {
  const schema = z.object({ enabled: z.boolean(), limit: z.number() });
  const key = "cache:test:settings";

  it("set → get round-trips through schema validation", async (ctx) => {
    const { connections } = requireRedis(ctx);
    await cacheSetJson(
      connections.client,
      key,
      { enabled: true, limit: 5 },
      60,
    );
    const value = await cacheGetJson(connections.client, key, schema);
    expect(value).toEqual({ enabled: true, limit: 5 });
  });

  it("explicit bust removes the entry", async (ctx) => {
    const { connections } = requireRedis(ctx);
    await cacheBust(connections.client, key);
    expect(await cacheGetJson(connections.client, key, schema)).toBeUndefined();
  });

  it("treats a wrong-shaped entry as a miss and self-heals", async (ctx) => {
    const { connections } = requireRedis(ctx);
    await connections.client.set(key, JSON.stringify({ wrong: "shape" }));
    expect(await cacheGetJson(connections.client, key, schema)).toBeUndefined();
    expect(await connections.client.get(key)).toBeNull();
  });
});
