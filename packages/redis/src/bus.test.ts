import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import type { EventName, TypedEvent } from "@neelkanth/contracts";
import { createEventBus, type EventBusOptions } from "./bus.js";

const TICK = {
  symbol: "NSE:RELIANCE-EQ",
  ltp: 1400.5,
  volume: 10,
  ts: 1_760_000_000_000,
} as const;

/** Lets a test wait for the bus's deferred (setImmediate) dispatch. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function harness(options: EventBusOptions = {}) {
  const published: { channel: string; message: string }[] = [];
  const subscribed: string[] = [];
  const errors: { error: unknown; context: Record<string, unknown> }[] = [];
  let onMessage: ((channel: string, message: string) => void) | undefined;

  const publisher = {
    publish: (channel: string, message: string) => {
      published.push({ channel, message });
      return Promise.resolve(1);
    },
  } as unknown as Redis;

  const subscriber = {
    on: (event: string, listener: (c: string, m: string) => void) => {
      if (event === "message") onMessage = listener;
      return subscriber;
    },
    subscribe: (channel: string) => {
      subscribed.push(channel);
      return Promise.resolve(1);
    },
    unsubscribe: () => Promise.resolve(1),
  } as unknown as Redis;

  const bus = createEventBus(
    publisher,
    subscriber,
    (error, context) => errors.push({ error, context }),
    options,
  );
  return {
    bus,
    published,
    subscribed,
    errors,
    /** Simulate Redis delivering a message back on the subscriber socket. */
    deliver: (channel: string, message: string) => onMessage?.(channel, message),
    hasListener: () => onMessage !== undefined,
  };
}

describe("EventBus — in-process delivery (the default)", () => {
  it("delivers to local handlers without touching Redis", async () => {
    const h = harness();
    const seen: TypedEvent<EventName>[] = [];
    await h.bus.subscribe("MARKET_TICK", (event) => {
      seen.push(event);
    });
    await h.bus.publish("MARKET_TICK", TICK);
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toEqual(TICK);
    // The whole point: no round trip out to Upstash and back to ourselves.
    expect(h.published).toHaveLength(0);
  });

  it("issues no SUBSCRIBE and installs no socket listener for a local channel", async () => {
    const h = harness();
    await h.bus.subscribe("MARKET_TICK", () => undefined);
    expect(h.subscribed).toHaveLength(0);
    expect(h.hasListener()).toBe(false);
  });

  it("fans out to every handler on the channel exactly once", async () => {
    const h = harness();
    const a = vi.fn();
    const b = vi.fn();
    await h.bus.subscribe("MARKET_TICK", a);
    await h.bus.subscribe("MARKET_TICK", b);
    await h.bus.publish("MARKET_TICK", TICK);
    await settle();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  /**
   * Delivery must stay deferred. Running handlers inline would make `publish`
   * backpressure: a candle close would block tick ingestion inside the
   * broker's own socket callback.
   */
  it("returns before any handler runs", async () => {
    const h = harness();
    const order: string[] = [];
    await h.bus.subscribe("MARKET_TICK", () => {
      order.push("handler");
    });
    await h.bus.publish("MARKET_TICK", TICK);
    order.push("after publish");
    await settle();

    expect(order).toEqual(["after publish", "handler"]);
  });

  it("routes a rejected handler to onError without stalling the others", async () => {
    const h = harness();
    const after = vi.fn();
    await h.bus.subscribe("MARKET_TICK", () => Promise.reject(new Error("boom")));
    await h.bus.subscribe("MARKET_TICK", after);
    await h.bus.publish("MARKET_TICK", TICK);
    await settle();
    await settle(); // the rejection lands a microtask later

    expect(after).toHaveBeenCalledTimes(1);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.context).toMatchObject({ event: "MARKET_TICK" });
  });

  it("routes a synchronous throw to onError without stalling the others", async () => {
    const h = harness();
    const after = vi.fn();
    await h.bus.subscribe("MARKET_TICK", () => {
      throw new Error("boom");
    });
    await h.bus.subscribe("MARKET_TICK", after);
    await h.bus.publish("MARKET_TICK", TICK);
    await settle();

    expect(after).toHaveBeenCalledTimes(1);
    expect(h.errors).toHaveLength(1);
  });

  it("still validates the payload on the way out", async () => {
    const h = harness();
    await expect(
      h.bus.publish("MARKET_TICK", { ...TICK, ltp: -5 }),
    ).rejects.toThrow();
  });

  it("hands handlers a payload that does not alias the producer's object", async () => {
    const h = harness();
    let received: { volume: number } | undefined;
    await h.bus.subscribe("MARKET_TICK", (event) => {
      received = event.payload;
    });
    const mutable: { symbol: string; ltp: number; volume: number; ts: number } = {
      ...TICK,
    };
    await h.bus.publish("MARKET_TICK", mutable);
    mutable.volume = 9999;
    await settle();

    expect(received?.volume).toBe(10);
  });

  it("delivers nothing after close", async () => {
    const h = harness();
    const handler = vi.fn();
    await h.bus.subscribe("MARKET_TICK", handler);
    await h.bus.publish("MARKET_TICK", TICK);
    await h.bus.close();
    await settle();

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("EventBus — Redis delivery (declared cross-process channels)", () => {
  const options: EventBusOptions = { redisEvents: ["ORDER_FILLED"] };

  it("publishes a declared channel to Redis instead of delivering locally", async () => {
    const h = harness(options);
    const handler = vi.fn();
    await h.bus.subscribe("ORDER_FILLED", handler);
    await h.bus.publish("ORDER_FILLED", {
      orderId: "ord_1",
      strategyId: "str_1",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 1,
      filledPrice: 1400,
      slippage: 0,
      charges: 0,
      filledAt: 1_760_000_000_000,
      mode: "paper",
      ts: 1_760_000_000_000,
    });
    await settle();

    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.channel).toBe("events:ORDER_FILLED");
    // Delivered by the echo, not by the publish — exactly once, not twice.
    expect(handler).not.toHaveBeenCalled();
  });

  it("subscribes on Redis and delivers what the socket echoes back", async () => {
    const h = harness(options);
    const seen: TypedEvent<EventName>[] = [];
    await h.bus.subscribe("ORDER_FILLED", (event) => {
      seen.push(event);
    });
    expect(h.subscribed).toEqual(["events:ORDER_FILLED"]);

    await h.bus.publish("ORDER_FILLED", {
      orderId: "ord_1",
      strategyId: "str_1",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 1,
      filledPrice: 1400,
      slippage: 0,
      charges: 0,
      filledAt: 1_760_000_000_000,
      mode: "paper",
      ts: 1_760_000_000_000,
    });
    h.deliver("events:ORDER_FILLED", h.published[0]?.message ?? "");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("ORDER_FILLED");
    expect(JSON.stringify(seen[0]?.payload)).toContain("ord_1");
  });

  it("surfaces a malformed wire message instead of delivering it", async () => {
    const h = harness(options);
    const handler = vi.fn();
    await h.bus.subscribe("ORDER_FILLED", handler);
    h.deliver("events:ORDER_FILLED", "{not json");

    expect(handler).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(1);
  });

  it("mixes both modes on one bus", async () => {
    const h = harness(options);
    const local = vi.fn();
    const remote = vi.fn();
    await h.bus.subscribe("MARKET_TICK", local);
    await h.bus.subscribe("ORDER_FILLED", remote);
    await h.bus.publish("MARKET_TICK", TICK);
    await settle();

    expect(local).toHaveBeenCalledTimes(1);
    expect(h.published).toHaveLength(0);
    expect(h.subscribed).toEqual(["events:ORDER_FILLED"]);
  });
});
