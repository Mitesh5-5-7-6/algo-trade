import type { Db } from "mongodb";
import {
  OptionChainSnapshotSchema,
  type OptionChainSnapshot,
} from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * The option chain as it stood, every 5 minutes of the session (PLAN.md
 * 14.23, operator decision 2026-11-28). Expired contracts cannot be fetched
 * from the broker afterwards, so a day not kept is a day research can never
 * test option strategies on. One document per underlying and instant; a
 * repeat of the same instant is ignored, so a restart never doubles a row.
 */
export class OptionChainSnapshotsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.optionChainSnapshots);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { underlying: 1, asOf: 1 },
      { unique: true },
    );
  }

  /** Keeps the snapshot; false when this instant was already kept. */
  async insert(snapshot: OptionChainSnapshot): Promise<boolean> {
    const doc = OptionChainSnapshotSchema.parse(snapshot);
    const result = await this.collection.updateOne(
      { underlying: doc.underlying, asOf: doc.asOf },
      { $setOnInsert: { ...doc } },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  }

  /** One underlying's snapshots in [from, to), oldest first. */
  async findRange(
    underlying: string,
    from: number,
    to: number,
  ): Promise<OptionChainSnapshot[]> {
    const docs = await this.collection
      .find(
        { underlying, asOf: { $gte: from, $lt: to } },
        { projection: { _id: 0 } },
      )
      .sort({ asOf: 1 })
      .toArray();
    return docs.map((doc) => OptionChainSnapshotSchema.parse(doc));
  }
}
