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
 * Integration tests against REAL Redis (plan/27 §2): docker-compose.dev.yml
 * locally, service containers in CI. No mocks — the event relay test is the
 * license for the whole Regime B design.
 */
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

let connections: RedisConnections;
let bus: EventBus;
const busErrors: unknown[] = [];

beforeAll(async () => {
  connections = createRedisConnections(REDIS_URL);
  await connections.client.ping(); // fail fast if infra is absent
  bus = createEventBus(connections.publisher, connections.subscriber, (error) =>
    busErrors.push(error),
  );
});

afterAll(async () => {
  await bus.close();
  await connections.quit();
});

describe("key builders (plan/08 §9)", () => {
  it("produce namespace-prefixed keys", () => {
    expect(hotPriceKey("NSE:INFY-EQ")).toBe("hot:price:NSE:INFY-EQ");
    expect(riskDailyLossKey("2026-07-05")).toBe("risk:dailyLoss:2026-07-05");
    expect(rateLimitKey("broker", "orders")).toBe("ratelimit:broker:orders");
  });
});

describe("event bus (plan/09)", () => {
  it("round-trips a validated ORDER_FILLED to a subscriber", async () => {
    const received: unknown[] = [];
    await bus.subscribe("ORDER_FILLED", (event) => {
      received.push(event);
    });

    await bus.publish(
      "ORDER_FILLED",
      {
        orderId: "ord_it_1",
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

    await new Promise((resolve) => setTimeout(resolve, 300));
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

  it("refuses to publish a malformed payload (producer-side boundary)", async () => {
    await expect(
      bus.publish("ORDER_FILLED", {
        orderId: "ord_bad",
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

  it("surfaces malformed wire messages to onError, never to handlers", async () => {
    const before = busErrors.length;
    await connections.publisher.publish(
      "events:ORDER_FILLED",
      "{not json at all",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(busErrors.length).toBeGreaterThan(before);
  });
});

describe("cache helpers (plan/08 §4)", () => {
  const schema = z.object({ enabled: z.boolean(), limit: z.number() });
  const key = "cache:test:settings";

  it("set → get round-trips through schema validation", async () => {
    await cacheSetJson(
      connections.client,
      key,
      { enabled: true, limit: 5 },
      60,
    );
    const value = await cacheGetJson(connections.client, key, schema);
    expect(value).toEqual({ enabled: true, limit: 5 });
  });

  it("explicit bust removes the entry", async () => {
    await cacheBust(connections.client, key);
    expect(await cacheGetJson(connections.client, key, schema)).toBeUndefined();
  });

  it("treats a wrong-shaped entry as a miss and self-heals", async () => {
    await connections.client.set(key, JSON.stringify({ wrong: "shape" }));
    expect(await cacheGetJson(connections.client, key, schema)).toBeUndefined();
    expect(await connections.client.get(key)).toBeNull();
  });
});
