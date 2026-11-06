import type { NotificationRecord } from "@neelkanth/db";
import type { DeliveryOutcome } from "./notifier.js";

/**
 * What is kept of one message (task 16.6, D7): the message as composed, its
 * outcome, and the chat it went to (D8). One shape for the API and the CLIs.
 */
export function recordOf(
  outcome: DeliveryOutcome,
  notificationId: string,
  ts: number,
): NotificationRecord {
  const n = outcome.notification;
  return {
    notificationId,
    ts,
    severity: n.severity,
    mode: n.mode,
    title: n.title,
    ...(n.body === undefined ? {} : { body: n.body }),
    outcome: outcome.outcome,
    attempts: outcome.attempts,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(n.dedupeKey === undefined ? {} : { dedupeKey: n.dedupeKey }),
    chat: n.chat ?? "operations",
  };
}
