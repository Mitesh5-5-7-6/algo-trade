import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@neelkanth/logger";
import { buildServer, type ApiServer } from "../server.js";
import { normalizeFyersWebhook, type FyersWebhookEvent } from "./payload.js";
import { FYERS_WEBHOOK_PATH, registerFyersWebhookRoutes } from "./routes.js";

/** Silent logger — swallow output during tests. */
function silentLogger() {
  return createLogger({
    level: "fatal",
    name: "test",
    destination: {
      write() {
        return true;
      },
    },
  });
}

function makeApp(options: { secret?: string } = {}): {
  app: ApiServer;
  delivered: FyersWebhookEvent[];
  deliver: ReturnType<typeof vi.fn>;
} {
  const app = buildServer({ logger: silentLogger(), readinessChecks: [] });
  const delivered: FyersWebhookEvent[] = [];
  const deliver = vi.fn((event: FyersWebhookEvent) => {
    delivered.push(event);
    return Promise.resolve();
  });
  registerFyersWebhookRoutes(app, { secret: options.secret, deliver });
  return { app, delivered, deliver };
}

/** A FYERS order update as the broker sends it: envelope + numeric codes. */
const ORDER_UPDATE = {
  s: "ok",
  d: {
    id: "808058117761",
    exchOrdId: "1300000010650",
    symbol: "NSE:SBIN-EQ",
    side: 1,
    status: 2,
    qty: 10,
    filledQty: 10,
    limitPrice: 0,
    tradedPrice: 812.5,
    orderDateTime: "18-Aug-2025 10:15:22",
  },
};

describe("normalizeFyersWebhook (plan/04 §4 boundary)", () => {
  it("unwraps the envelope and decodes the broker's numeric codes", () => {
    const event = normalizeFyersWebhook(ORDER_UPDATE, 1_700_000_000_000);

    expect(event).toMatchObject({
      source: "fyers",
      kind: "order",
      receivedAt: 1_700_000_000_000,
      brokerOrderId: "808058117761",
      exchangeOrderId: "1300000010650",
      symbol: "NSE:SBIN-EQ",
      side: "BUY",
      status: "filled",
      qty: 10,
      filledQty: 10,
      price: 812.5,
    });
  });

  it("keeps the untouched payload — normalization is additive, never lossy", () => {
    const event = normalizeFyersWebhook(ORDER_UPDATE, 1);
    expect(event.raw).toEqual(ORDER_UPDATE);
  });

  it("decodes sell orders; -1 is the only thing that means SELL", () => {
    const sell = normalizeFyersWebhook({ d: { side: -1, id: "1" } }, 1);
    expect(sell.side).toBe("SELL");
  });

  it("leaves an unrecognized side undefined rather than guessing a direction", () => {
    const event = normalizeFyersWebhook({ d: { side: 99, id: "1" } }, 1);
    expect(event.side).toBeUndefined();
  });

  it("maps each documented status code", () => {
    const statusOf = (code: number) =>
      normalizeFyersWebhook({ d: { id: "1", status: code } }, 1).status;

    expect(statusOf(1)).toBe("cancelled");
    expect(statusOf(2)).toBe("filled");
    expect(statusOf(4)).toBe("transit");
    expect(statusOf(5)).toBe("rejected");
    expect(statusOf(6)).toBe("pending");
    // 3 is reserved by the broker and unused: honestly unknown, not defaulted.
    expect(statusOf(3)).toBeUndefined();
  });

  it("treats an empty body and a bare {s:'ok'} as the broker's liveness probe", () => {
    expect(normalizeFyersWebhook({}, 1).kind).toBe("ping");
    expect(normalizeFyersWebhook({ s: "ok", code: 200 }, 1).kind).toBe("ping");
    expect(normalizeFyersWebhook(undefined, 1).kind).toBe("ping");
  });

  it("classifies position and trade payloads apart from orders", () => {
    expect(normalizeFyersWebhook({ d: { netQty: 5, symbol: "X" } }, 1).kind).toBe(
      "position",
    );
    expect(
      normalizeFyersWebhook({ trades: { tradeNumber: "77", qty: 1 } }, 1).kind,
    ).toBe("trade");
  });

  it("survives nulls where the broker documents numbers", () => {
    const event = normalizeFyersWebhook(
      { d: { id: "1", qty: null, tradedPrice: null, symbol: null } },
      1,
    );
    expect(event.qty).toBeUndefined();
    expect(event.price).toBeUndefined();
    expect(event.symbol).toBeUndefined();
    expect(event.kind).toBe("order");
  });

  it("keeps an unreadable body instead of dropping it", () => {
    const event = normalizeFyersWebhook("not an object", 1);
    expect(event.kind).toBe("unknown");
    expect(event.raw).toBe("not an object");
  });
});

describe("FYERS webhook route (plan/05 §4.1)", () => {
  it("answers GET 200 so the broker's URL validator accepts the endpoint", async () => {
    const { app, deliver } = makeApp();
    const res = await app.inject({ method: "GET", url: FYERS_WEBHOOK_PATH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, source: "fyers" });
    expect(deliver).not.toHaveBeenCalled();
    await app.close();
  });

  it("queues an order update and answers 200 (not 202: brokers disable non-200)", async () => {
    const { app, delivered } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: FYERS_WEBHOOK_PATH,
      payload: ORDER_UPDATE,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: true, kind: "order" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.brokerOrderId).toBe("808058117761");
    await app.close();
  });

  it("answers a ping without queuing — a probe is not an event", async () => {
    const { app, deliver } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: FYERS_WEBHOOK_PATH,
      payload: { s: "ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: false, kind: "ping" });
    expect(deliver).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a POST with no secret when one is configured", async () => {
    const { app, deliver } = makeApp({ secret: "s".repeat(16) });
    const res = await app.inject({
      method: "POST",
      url: FYERS_WEBHOOK_PATH,
      payload: ORDER_UPDATE,
    });

    expect(res.statusCode).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a wrong secret, and never says which part was wrong", async () => {
    const { app } = makeApp({ secret: "s".repeat(16) });
    const res = await app.inject({
      method: "POST",
      url: FYERS_WEBHOOK_PATH,
      headers: { "x-webhook-secret": "w".repeat(16) },
      payload: ORDER_UPDATE,
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.json())).not.toContain("ssss");
    await app.close();
  });

  it("accepts the secret from the header", async () => {
    const secret = "s".repeat(16);
    const { app, delivered } = makeApp({ secret });
    const res = await app.inject({
      method: "POST",
      url: FYERS_WEBHOOK_PATH,
      headers: { "x-webhook-secret": secret },
      payload: ORDER_UPDATE,
    });

    expect(res.statusCode).toBe(200);
    expect(delivered).toHaveLength(1);
    await app.close();
  });

  it("accepts the secret from ?token= — the broker cannot set headers", async () => {
    const secret = "s".repeat(16);
    const { app, delivered } = makeApp({ secret });
    const res = await app.inject({
      method: "POST",
      url: `${FYERS_WEBHOOK_PATH}?token=${secret}`,
      payload: ORDER_UPDATE,
    });

    expect(res.statusCode).toBe(200);
    expect(delivered).toHaveLength(1);
    await app.close();
  });

  it("still validates the URL unauthenticated while a secret is configured", async () => {
    const { app } = makeApp({ secret: "s".repeat(16) });
    const res = await app.inject({ method: "GET", url: FYERS_WEBHOOK_PATH });

    expect(res.statusCode).toBe(200);
    // The probe must not leak that a secret exists.
    expect(JSON.stringify(res.json())).not.toContain("secret");
    await app.close();
  });

  it("does not claim 2xx when the delivery could not be persisted", async () => {
    const app = buildServer({ logger: silentLogger(), readinessChecks: [] });
    registerFyersWebhookRoutes(app, {
      deliver: () => Promise.reject(new Error("redis down")),
    });

    const res = await app.inject({
      method: "POST",
      url: FYERS_WEBHOOK_PATH,
      payload: ORDER_UPDATE,
    });

    // 5xx, so a sender that retries gets the chance to.
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
