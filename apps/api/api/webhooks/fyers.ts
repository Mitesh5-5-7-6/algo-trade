/**
 * Vercel Serverless Function — `/api/webhooks/fyers`.
 *
 * WHY THIS EXISTS AS A FUNCTION AND NOT A FASTIFY ROUTE
 * -----------------------------------------------------
 * The control plane (`src/`) is a long-lived Fastify process holding socket.io,
 * BullMQ workers and Mongo/Redis pools; this deployment is a static shell in
 * front of it (see `public/index.html`). FYERS, however, needs a public HTTPS
 * URL it can reach *and validate* before it will save a webhook at all. So the
 * broker's callback lands here, at the edge, and this function does exactly one
 * thing: park the delivery durably in Redis. The engines drain
 * `webhooks:fyers:inbox` on their own schedule.
 *
 * That split is the point. A webhook is fire-and-forget — the broker does not
 * redeliver — so accepting fast and persisting immediately beats trying to do
 * anything clever while the sender waits.
 *
 * DELIBERATELY SELF-CONTAINED: no `@neelkanth/*` imports. This file is bundled
 * by Vercel's Node builder outside the workspace's project graph, so it depends
 * only on `ioredis` and the Node standard library. The two Redis key strings
 * below duplicate `packages/redis/src/keys.ts`; both sides must move together.
 *
 * ENVIRONMENT (set on the Vercel project):
 *   REDIS_URL             — where the inbox lives. Unset => log-only, still 200.
 *   FYERS_WEBHOOK_SECRET  — required credential once set. Register the URL as
 *                           `https://…/api/webhooks/fyers?token=<secret>`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Redis } from "ioredis";

/** Mirrors `webhookInboxKey("fyers")` / `webhookChannel("fyers")`. */
const INBOX_KEY = "webhooks:fyers:inbox";
const CHANNEL = "webhooks:fyers";
const INBOX_MAX = 1000;

/** Refuse a body large enough to be an attack rather than an order update. */
const MAX_BODY_BYTES = 256 * 1024;
/** A serverless invocation must not hang on an unreachable Redis. */
const REDIS_CONNECT_TIMEOUT_MS = 5_000;

interface JsonResponse {
  ok: boolean;
  [key: string]: unknown;
}

function send(res: ServerResponse, status: number, body: JsonResponse): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Nothing here is cacheable and a cached 200 would swallow real deliveries.
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/**
 * Read the raw request body. Vercel's Node bridge sometimes pre-buffers and
 * exposes `req.body`; when it does, the stream is already drained, so we check
 * both. Reading raw (rather than trusting a parsed body) also keeps the door
 * open for signature verification if FYERS ever adds one.
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("webhook body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length > 0) return Buffer.concat(chunks).toString("utf8");

  const preParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (typeof preParsed === "string") return preParsed;
  if (Buffer.isBuffer(preParsed)) return preParsed.toString("utf8");
  if (preParsed !== undefined && preParsed !== null) {
    return JSON.stringify(preParsed);
  }
  return "";
}

/** Constant-time compare; unequal lengths short-circuit (they cannot match). */
function secretMatches(expected: string, presented: string | null): boolean {
  if (presented === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function presentedSecret(req: IncomingMessage, url: URL): string | null {
  const header = req.headers["x-webhook-secret"];
  if (typeof header === "string" && header.length > 0) return header;
  return url.searchParams.get("token") ?? url.searchParams.get("secret");
}

/**
 * Persist one delivery: push onto the inbox, trim it, and nudge any live
 * consumer. All three in a single pipeline so the round trip is paid once —
 * this runs while the broker is holding the connection open.
 */
async function enqueue(redisUrl: string, record: string): Promise<void> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    // A serverless invocation has no time to sit in a retry loop: fail fast
    // and let the 503 tell the truth instead of timing out silently.
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // An EventEmitter with no `error` listener throws on emit. The failure is
  // already reported by the rejected `connect`/`exec` below, so this listener
  // exists only to keep a connection refusal from taking the process with it.
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis
      .multi()
      .lpush(INBOX_KEY, record)
      .ltrim(INBOX_KEY, 0, INBOX_MAX - 1)
      .publish(CHANNEL, record)
      .exec();
  } finally {
    // `disconnect`, not `quit`: the container may be frozen mid-QUIT anyway,
    // and the write is already acknowledged by this point.
    redis.disconnect();
  }
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://webhook.local");

  // FYERS validates a webhook URL by calling it before any secret can be
  // configured on it, so the probe must answer unauthenticated. It touches
  // nothing and discloses nothing — including whether a secret is set.
  if (req.method === "GET" || req.method === "HEAD") {
    send(res, 200, { ok: true, source: "fyers", endpoint: "webhook" });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("allow", "GET, HEAD, POST");
    send(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const secret = process.env["FYERS_WEBHOOK_SECRET"];
  if (secret !== undefined && secret.length > 0) {
    if (!secretMatches(secret, presentedSecret(req, url))) {
      // No detail: a 401 that explains itself is a hint to whoever guessed.
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch {
    send(res, 413, { ok: false, error: "payload_too_large" });
    return;
  }

  // An empty POST is the other shape a liveness probe takes. It carries no
  // event, so it is answered but never queued.
  if (rawBody.trim().length === 0) {
    send(res, 200, { ok: true, queued: false, kind: "ping" });
    return;
  }

  // Undecodable JSON is still kept: the raw text goes to the inbox verbatim so
  // a broker-side format change is recoverable rather than lost to a 400.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = { unparsed: rawBody };
  }

  const record = JSON.stringify({
    source: "fyers",
    receivedAt: Date.now(),
    contentType: req.headers["content-type"] ?? null,
    payload: parsed,
  });

  const redisUrl = process.env["REDIS_URL"];
  if (redisUrl === undefined || redisUrl.length === 0) {
    // Not an error: an unconfigured deployment should still validate and stay
    // observable. The delivery is visible in the function log, and the honest
    // `queued: false` says plainly that nothing was persisted.
    console.warn("fyers webhook received but REDIS_URL is unset", record);
    send(res, 200, { ok: true, queued: false, reason: "redis_not_configured" });
    return;
  }

  try {
    await enqueue(redisUrl, record);
  } catch (error) {
    // We could not take ownership of the event, so we must not claim 2xx —
    // a sender that retries deserves the chance to.
    console.error("fyers webhook enqueue failed", error);
    send(res, 503, { ok: false, error: "queue_unavailable" });
    return;
  }

  send(res, 200, { ok: true, queued: true });
}
