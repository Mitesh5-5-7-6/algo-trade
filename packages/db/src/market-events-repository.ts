import type { Db } from "mongodb";
import { MarketEventSchema, type MarketEvent } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * Scheduled events by the Indian session they affect — RBI policy, the Union
 * Budget, US FOMC decisions (operator decision 2026-11-28) — RESEARCH
 * database only. Each with the page its date was read from. One row per
 * (date, kind, title): loading the calendar again adds nothing.
 */
export class MarketEventsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.marketEvents);
  }

  /** Keeps the event; false when it was already kept. */
  async upsert(event: MarketEvent): Promise<boolean> {
    const doc = MarketEventSchema.parse(event);
    const result = await this.collection.updateOne(
      { date: doc.date, kind: doc.kind, title: doc.title },
      { $setOnInsert: { ...doc } },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  }

  /** The events of one IST session date. */
  async onDate(date: string): Promise<MarketEvent[]> {
    const docs = await this.collection
      .find({ date }, { projection: { _id: 0 } })
      .sort({ kind: 1, title: 1 })
      .toArray();
    return docs.map((doc) => MarketEventSchema.parse(doc));
  }

  async count(): Promise<number> {
    return this.collection.countDocuments();
  }
}
