import type { Db } from "mongodb";
import { SignalSchema, type Signal } from "@neelkanth/core";
import { COLLECTIONS, TTL } from "./collections.js";

/**
 * Signals (plan/07 `signals`): the decision log, append-only, sole-written by
 * the Strategy Engine. Retention is split by side (operator decision): HOLD
 * rows — highest-volume, lowest-forensic-value — carry an `expireAt` so the
 * TTL index reaps them after ~30 days; BUY/SELL rows are permanent (plan/07 §4).
 */
export class SignalsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.signals);
  }

  async insert(signal: Signal): Promise<void> {
    const doc = SignalSchema.parse(signal);
    const record: Record<string, unknown> = { ...doc };
    if (doc.side === "HOLD") {
      // Only HOLD docs carry expireAt; the TTL index expires them at that time.
      record["expireAt"] = new Date(doc.ts + TTL.holdSignals * 1000);
    }
    await this.collection.insertOne(record);
  }

  /** Recent signals for a strategy, newest first (dashboard/audit reads). */
  async findRecentByStrategy(
    strategyId: string,
    limit: number,
  ): Promise<Signal[]> {
    const docs = await this.collection
      .find({ strategyId }, { projection: { _id: 0, expireAt: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => SignalSchema.parse(doc));
  }

  /** Recent signals across all strategies, newest first. */
  async findRecent(limit: number): Promise<Signal[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0, expireAt: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => SignalSchema.parse(doc));
  }
}
