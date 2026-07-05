import { z } from "zod";
import { TimestampSchema } from "@neelkanth/core";
import {
  EVENT_PAYLOAD_SCHEMAS,
  EventNameSchema,
  type EventName,
  type EventPayload,
} from "./events.js";

/**
 * The common event envelope (plan/09 §3). `correlationId` threads one decision
 * through every fact it produced — a signal id carried on the resulting
 * ORDER_PLACED, ORDER_FILLED, POSITION_UPDATED — because determinism is only
 * auditable if one decision is traceable end-to-end.
 */
export const EventEnvelopeSchema = z.object({
  name: EventNameSchema,
  ts: TimestampSchema,
  correlationId: z.string().min(1).optional(),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export interface TypedEvent<N extends EventName> {
  name: N;
  ts: number;
  correlationId?: string;
  payload: EventPayload<N>;
}

/**
 * Parse an unknown wire message into a fully-validated typed event.
 * Envelope AND payload are checked — a malformed payload never reaches a
 * consumer as a "mostly right" object (validate at the boundary, plan/04 §4).
 */
export function parseEvent(raw: unknown): TypedEvent<EventName> {
  const envelope = EventEnvelopeSchema.parse(raw);
  const payloadSchema = EVENT_PAYLOAD_SCHEMAS[envelope.name];
  const payload = payloadSchema.parse(envelope.payload);
  return { ...envelope, payload } as TypedEvent<EventName>;
}

/** Build a validated envelope for emission. */
export function buildEvent<N extends EventName>(
  name: N,
  payload: EventPayload<N>,
  correlationId?: string,
): TypedEvent<N> {
  const parsed = EVENT_PAYLOAD_SCHEMAS[name].parse(payload) as EventPayload<N>;
  return {
    name,
    ts: Date.now(),
    ...(correlationId === undefined ? {} : { correlationId }),
    payload: parsed,
  };
}
