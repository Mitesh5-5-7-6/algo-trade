import type { Db } from "mongodb";
import { TradeCardSchema, type TradeCard } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * `trade_cards`: what to trade for each approved entry (decided by the
 * operator 2026-11-18). Written once per signal by the runtime, read by the
 * dashboard; nothing in the order path reads it.
 */
export class TradeCardsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.tradeCards);
  }

  /** One card per signal: a second write of the same signal is ignored. */
  async insert(card: TradeCard): Promise<void> {
    const doc = TradeCardSchema.parse(card);
    await this.collection.updateOne(
      { signalId: doc.signalId },
      { $setOnInsert: doc },
      { upsert: true },
    );
  }

  /** Cards at or after `since`, newest first, at most `limit`. */
  async findSince(since: number, limit: number): Promise<TradeCard[]> {
    const docs = await this.collection
      .find({ ts: { $gte: since } }, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => TradeCardSchema.parse(doc));
  }
}
