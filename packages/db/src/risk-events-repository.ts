import type { Db } from "mongodb";
import { RiskEventSchema, type RiskEvent } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/** Durable, signal-independent risk events (for example broker mismatches). */
export class RiskEventsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.riskEvents);
  }

  async insert(event: RiskEvent): Promise<void> {
    const doc = RiskEventSchema.parse(event);
    await this.collection.insertOne({ ...doc });
  }

  async findRecent(limit: number): Promise<RiskEvent[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => RiskEventSchema.parse(doc));
  }
}
