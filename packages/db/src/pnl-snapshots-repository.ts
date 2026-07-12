import type { Db } from "mongodb";
import { PnlSnapshotSchema, type PnlSnapshot } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * PnL snapshots (plan/07 `pnl_snapshots`, plan/13 §6): the durable equity
 * curve, one row per scope per trading day. Upsert by (scope, date) so a
 * re-run of the EOD pass is idempotent.
 */
export class PnlSnapshotsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.pnlSnapshots);
  }

  async upsert(snapshot: PnlSnapshot): Promise<void> {
    const doc = PnlSnapshotSchema.parse(snapshot);
    await this.collection.updateOne(
      { scope: doc.scope, date: doc.date },
      { $set: doc },
      { upsert: true },
    );
  }

  /** The equity curve for a scope, oldest→newest (dashboard PnL history). */
  async findByScope(scope: string, limit: number): Promise<PnlSnapshot[]> {
    const docs = await this.collection
      .find({ scope }, { projection: { _id: 0 } })
      .sort({ date: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => PnlSnapshotSchema.parse(doc)).reverse();
  }
}
