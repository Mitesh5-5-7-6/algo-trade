import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../../api/webhooks/fyers.js";

/**
 * The Vercel function is the endpoint FYERS actually calls, so it is driven
 * here over a real socket rather than with a mocked req/res pair — the parts
 * most likely to break (stream-read of the body, method routing, header
 * casing) only exist once there is a real HTTP conversation.
 */
let server: Server;
let origin: string;

beforeEach(async () => {
  server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

const ORDER_UPDATE = JSON.stringify({
  s: "ok",
  d: { id: "808058117761", symbol: "NSE:SBIN-EQ", side: 1, status: 2 },
});

describe("edge function /api/webhooks/fyers", () => {
  it("answers GET 200 — this is what FYERS' URL validator calls", async () => {
    const res = await fetch(`${origin}/api/webhooks/fyers`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      source: "fyers",
      endpoint: "webhook",
    });
  });

  it("answers HEAD 200 too — some validators probe with HEAD", async () => {
    const res = await fetch(`${origin}/api/webhooks/fyers`, { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("refuses other methods and says which ones it takes", async () => {
    const res = await fetch(`${origin}/api/webhooks/fyers`, {
      method: "DELETE",
    });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
  });

  it("accepts a delivery and reports honestly that nothing was persisted", async () => {
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("FYERS_WEBHOOK_SECRET", "");

    const res = await fetch(`${origin}/api/webhooks/fyers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ORDER_UPDATE,
    });

    // 2xx so an unconfigured deployment still validates, `queued: false` so
    // nobody mistakes that for the event having been stored.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      queued: false,
      reason: "redis_not_configured",
    });
  });

  it("treats an empty POST as a probe, not a lost event", async () => {
    vi.stubEnv("REDIS_URL", "");
    const res = await fetch(`${origin}/api/webhooks/fyers`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: false, kind: "ping" });
  });

  it("rejects a POST missing the configured secret", async () => {
    vi.stubEnv("FYERS_WEBHOOK_SECRET", "s".repeat(24));

    const res = await fetch(`${origin}/api/webhooks/fyers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ORDER_UPDATE,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("accepts the secret from ?token= — FYERS cannot set a header", async () => {
    const secret = "s".repeat(24);
    vi.stubEnv("FYERS_WEBHOOK_SECRET", secret);
    vi.stubEnv("REDIS_URL", "");

    const res = await fetch(
      `${origin}/api/webhooks/fyers?token=${secret}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ORDER_UPDATE,
      },
    );

    expect(res.status).toBe(200);
  });

  it("still answers the GET probe while a secret is configured", async () => {
    vi.stubEnv("FYERS_WEBHOOK_SECRET", "s".repeat(24));
    const res = await fetch(`${origin}/api/webhooks/fyers`);
    expect(res.status).toBe(200);
  });

  it("returns 503 rather than claiming 2xx when the inbox is unreachable", async () => {
    // Port 1 is reserved and refuses instantly — a stand-in for Redis down.
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    vi.stubEnv("FYERS_WEBHOOK_SECRET", "");

    const res = await fetch(`${origin}/api/webhooks/fyers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ORDER_UPDATE,
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "queue_unavailable" });
  });

  it("never caches — a cached 200 would swallow real deliveries", async () => {
    const res = await fetch(`${origin}/api/webhooks/fyers`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
