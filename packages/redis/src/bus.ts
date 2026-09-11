import type { Redis } from "ioredis";
import {
  buildEvent,
  eventChannel,
  parseEvent,
  type EventName,
  type EventPayload,
  type TypedEvent,
} from "@neelkanth/contracts";

/**
 * The event bus (plan/09): typed, validated fan-out, in-process by default and
 * over Redis Pub/Sub for the channels that genuinely cross a process boundary.
 *
 * Both directions validate against the contracts schemas — a producer
 * cannot emit a malformed payload, and a consumer never receives one
 * (plan/04 §4: validate at the boundary). Fire-and-forget by design
 * (plan/08 §3): recovery is resync, so consumers must be idempotent
 * (plan/09 §5).
 */
export interface EventBus {
  publish<N extends EventName>(
    name: N,
    payload: EventPayload<N>,
    correlationId?: string,
  ): Promise<void>;
  subscribe<N extends EventName>(
    name: N,
    handler: (event: TypedEvent<N>) => void | Promise<void>,
  ): Promise<void>;
  /** Unsubscribe everything (shutdown path). */
  close(): Promise<void>;
}

export interface EventBusOptions {
  /**
   * The events that must travel through Redis because a *different process*
   * consumes them. Everything else is delivered in-process.
   *
   * Empty by default, and that is the honest default for this system: the
   * engine, the strategy chain and the Socket.IO bridge all run in one process
   * and share one bus object, so publishing a MARKET_TICK sent it out over TCP
   * to Upstash and straight back to two handlers sitting in the publishing
   * process. At ~15 ticks/sec that round trip was ~96% of all Redis commands —
   * enough to spend a monthly quota in a single trading session.
   *
   * Kept as a list rather than deleted so splitting a consumer into its own
   * process later is a one-line change here, not a rewrite of the bus.
   */
  redisEvents?: readonly EventName[];
}

export function createEventBus(
  publisher: Redis,
  subscriber: Redis,
  onError: (error: unknown, context: Record<string, unknown>) => void,
  options: EventBusOptions = {},
): EventBus {
  const handlers = new Map<
    string,
    Array<(event: TypedEvent<EventName>) => void | Promise<void>>
  >();
  const viaRedis = new Set<EventName>(options.redisEvents ?? []);
  let listening = false;

  /**
   * Run every handler for a channel. Deliberately does NOT await them: the
   * Redis path never could (delivery arrives on a socket callback with no
   * caller to await it), and making the in-process path await would turn
   * `publish` into backpressure — a candle close would block tick ingestion
   * inside the broker's own socket callback. One consumer's failure never
   * stalls the others (plan/02 §10).
   */
  function dispatch(channel: string, event: TypedEvent<EventName>): void {
    const channelHandlers = handlers.get(channel);
    if (!channelHandlers || channelHandlers.length === 0) return;
    for (const handler of channelHandlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            onError(error, { channel, event: event.name });
          });
        }
      } catch (error) {
        onError(error, { channel, event: event.name });
      }
    }
  }

  function ensureListener() {
    if (listening) return;
    listening = true;
    subscriber.on("message", (channel: string, message: string) => {
      let event: TypedEvent<EventName>;
      try {
        event = parseEvent(JSON.parse(message));
      } catch (error) {
        // A malformed event is a bug somewhere — surfaced, never silently
        // dropped, never delivered as a "mostly right" object (plan/02 §10).
        onError(error, { channel, message });
        return;
      }
      dispatch(channel, event);
    });
  }

  return {
    // `async` so a validation failure surfaces as a rejection, never as a
    // synchronous throw into a caller that only awaits.
    async publish(name, payload, correlationId) {
      // Validated on the way out either way, so an in-process consumer is held
      // to exactly the same contract as a cross-process one. Zod returns a
      // fresh object, so handlers never alias the producer's payload.
      const event = buildEvent(name, payload, correlationId);
      const channel = eventChannel(name);
      if (viaRedis.has(name)) {
        await publisher.publish(channel, JSON.stringify(event));
        return;
      }
      // Deferred to a later macrotask rather than run inline, so `publish`
      // returns to its caller before consumers run — the same ordering the
      // Redis socket callback produced, minus the network.
      setImmediate(() => {
        dispatch(channel, event);
      });
    },

    async subscribe(name, handler) {
      const channel = eventChannel(name);
      const existing = handlers.get(channel) ?? [];
      existing.push(handler as (event: TypedEvent<EventName>) => void);
      handlers.set(channel, existing);
      // Only pay for a SUBSCRIBE on channels that actually arrive over Redis.
      if (!viaRedis.has(name)) return;
      ensureListener();
      await subscriber.subscribe(channel);
    },

    async close() {
      handlers.clear();
      if (listening) await subscriber.unsubscribe();
    },
  };
}
