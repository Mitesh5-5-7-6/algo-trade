import { timingSafeEqual } from "node:crypto";
import type { ApiServer } from "../server.js";
import { UnauthorizedError } from "../errors.js";
import {
  normalizeFyersWebhook,
  type FyersWebhookEvent,
} from "./payload.js";

/** The one public path for FYERS callbacks. Mirrored by the edge function. */
export const FYERS_WEBHOOK_PATH = "/webhooks/fyers";

/** Header the sender may carry the shared secret in, when it can set headers. */
export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

export interface FyersWebhookDeps {
  /**
   * Shared secret the caller must present. When undefined the endpoint is
   * OPEN — accepted only because FYERS validates a webhook URL by calling it
   * before you can configure anything on it, so the endpoint has to answer
   * before a secret can exist. Set it as soon as the URL is registered.
   */
  secret?: string | undefined;
  /**
   * Durable hand-off to the pipeline. Must resolve only once the event is
   * persisted: we answer 2xx on the strength of this promise, and a webhook
   * sender treats 2xx as "you own this event now" — there is no redelivery.
   */
  deliver: (event: FyersWebhookEvent) => Promise<void>;
}

/**
 * Constant-time secret comparison. A plain `===` on a secret leaks its prefix
 * through response timing; `timingSafeEqual` also throws on a length mismatch,
 * so lengths are equalized by comparing digest-length buffers of both.
 */
function secretMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Where a caller may put the secret: a header, or `?token=` in the URL. */
function presentedSecret(
  headers: Record<string, unknown>,
  query: unknown,
): string | undefined {
  const header = headers[WEBHOOK_SECRET_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  if (typeof query === "object" && query !== null) {
    const bag = query as Record<string, unknown>;
    for (const key of ["token", "secret"]) {
      const value = bag[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * The FYERS webhook surface (plan/05 §4.1).
 *
 * Three deliberate departures from the rest of the control plane:
 *
 * 1. **Unauthenticated by session.** A broker cannot hold an operator cookie,
 *    so this path is exempt from the auth guard and gated by a shared secret
 *    instead. It is therefore strictly write-only and echoes nothing back —
 *    an attacker who guesses the URL learns no money state.
 * 2. **GET answers 200.** FYERS refuses to save a webhook whose URL does not
 *    respond, and probes it unauthenticated. GET is that probe and nothing
 *    else: it never touches the pipeline and never reveals configuration.
 * 3. **A malformed body is still a 2xx.** Rejecting an unrecognized payload
 *    would make the next broker field change look like an outage. Unparseable
 *    deliveries are normalized to `kind: "unknown"` and queued whole, so the
 *    information survives even when our reading of it does not.
 */
export function registerFyersWebhookRoutes(
  app: ApiServer,
  deps: FyersWebhookDeps,
): void {
  // Liveness probe for the broker's URL validator (Fastify serves HEAD too).
  app.get(FYERS_WEBHOOK_PATH, () => ({ ok: true, source: "fyers" }));

  app.post(FYERS_WEBHOOK_PATH, async (request, reply) => {
    if (deps.secret !== undefined) {
      const presented = presentedSecret(request.headers, request.query);
      if (!secretMatches(deps.secret, presented)) {
        // No detail in the message: a 401 that explains itself is a hint.
        throw new UnauthorizedError("invalid webhook credentials");
      }
    }

    const event = normalizeFyersWebhook(request.body, Date.now());

    // A probe carries no event. Answering 200 without queuing keeps the
    // inbox free of noise the pipeline would have to learn to ignore.
    if (event.kind === "ping") {
      return reply.status(200).send({ ok: true, queued: false, kind: "ping" });
    }

    await deps.deliver(event);
    request.log.info(
      {
        kind: event.kind,
        brokerOrderId: event.brokerOrderId,
        symbol: event.symbol,
        status: event.status,
      },
      "fyers webhook queued",
    );

    // 200, not 202: brokers commonly treat anything but 200 as a failed
    // delivery and disable the webhook after a few of them.
    return reply.status(200).send({ ok: true, queued: true, kind: event.kind });
  });
}
