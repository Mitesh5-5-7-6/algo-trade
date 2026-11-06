import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * One operator notification and what became of it (Phase 16, task 16.6;
 * design LIVE_READINESS_AND_EXTENSIONS §5 D7): sent, failed after its
 * attempts, or dropped from a full queue. Kept so "was I told?" has an answer
 * that does not depend on the chat.
 *
 * Never a secret: the notifier's messages carry none (D5), and the record is
 * the message as composed — never the transport's URL or token.
 */
export const NotificationRecordSchema = z.object({
  notificationId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  severity: z.enum(["CRITICAL", "WARNING", "INFO"]),
  /** `research` from a research CLI (design §5.1 D10, task 16.9). */
  mode: z.enum(["paper", "live", "research"]),
  title: z.string().min(1),
  body: z.string().optional(),
  outcome: z.enum(["sent", "failed", "dropped"]),
  /** Delivery attempts made; 0 for a message dropped before any. */
  attempts: z.number().int().nonnegative(),
  /** Why it failed or was dropped. Already scrubbed by the transport. */
  reason: z.string().optional(),
  /** Set on a message that must go once — e.g. `summary:2026-11-02`. */
  dedupeKey: z.string().min(1).optional(),
  /**
   * The chat it went to (design §5.1 D8). Always written since task 16.8;
   * optional only because records kept before it have none.
   */
  chat: z.enum(["operations", "trades"]).optional(),
});
export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;

/**
 * `notifications` — operational, on the 90-day TTL the collection registry
 * gives it. The TTL index reads `createdAt`, which MongoDB only expires when
 * it is a BSON Date, so it is written as one beside the numeric `ts` the code
 * reads (as `signals` does with `expireAt`).
 */
export class NotificationsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.notifications);
  }

  async record(record: NotificationRecord): Promise<void> {
    const doc = NotificationRecordSchema.parse(record);
    await this.collection.insertOne({ ...doc, createdAt: new Date(doc.ts) });
  }

  /** Most recent first. */
  async findRecent(limit: number): Promise<NotificationRecord[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0, createdAt: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => NotificationRecordSchema.parse(doc));
  }

  /** Whether a message with this key was delivered — a failed one may go again. */
  async wasSent(dedupeKey: string): Promise<boolean> {
    const found = await this.collection.findOne(
      { dedupeKey, outcome: "sent" },
      { projection: { _id: 1 } },
    );
    return found !== null;
  }
}
