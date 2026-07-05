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
 * The event bus (plan/09): typed, validated fan-out over Redis Pub/Sub.
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

export function createEventBus(
  publisher: Redis,
  subscriber: Redis,
  onError: (error: unknown, context: Record<string, unknown>) => void,
): EventBus {
  const handlers = new Map<
    string,
    Array<(event: TypedEvent<EventName>) => void | Promise<void>>
  >();
  let listening = false;

  function ensureListener() {
    if (listening) return;
    listening = true;
    subscriber.on("message", (channel: string, message: string) => {
      const channelHandlers = handlers.get(channel);
      if (!channelHandlers || channelHandlers.length === 0) return;
      let event: TypedEvent<EventName>;
      try {
        event = parseEvent(JSON.parse(message));
      } catch (error) {
        // A malformed event is a bug somewhere — surfaced, never silently
        // dropped, never delivered as a "mostly right" object (plan/02 §10).
        onError(error, { channel, message });
        return;
      }
      for (const handler of channelHandlers) {
        try {
          const result = handler(event);
          if (result instanceof Promise) {
            result.catch((error: unknown) => {
              onError(error, { channel, event: event.name });
            });
          }
        } catch (error) {
          // One consumer's failure never stalls the others (plan/02 §10).
          onError(error, { channel, event: event.name });
        }
      }
    });
  }

  return {
    async publish(name, payload, correlationId) {
      const event = buildEvent(name, payload, correlationId);
      await publisher.publish(eventChannel(name), JSON.stringify(event));
    },

    async subscribe(name, handler) {
      ensureListener();
      const channel = eventChannel(name);
      const existing = handlers.get(channel) ?? [];
      existing.push(handler as (event: TypedEvent<EventName>) => void);
      handlers.set(channel, existing);
      await subscriber.subscribe(channel);
    },

    async close() {
      handlers.clear();
      await subscriber.unsubscribe();
    },
  };
}
