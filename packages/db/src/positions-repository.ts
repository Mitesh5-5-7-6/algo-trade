import type { Db } from "mongodb";
import { z } from "zod";
import { PositionSchema, type Position } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

const RealizedByStrategyRowSchema = z.object({
  _id: z.string(),
  total: z.number(),
});

/**
 * Positions (plan/07 `positions`): holdings + realized/unrealized basis,
 * sole-written by the Position Engine (plan/13 §3). Upsert by `positionId`
 * (the durable copy of the hot state); `findOpen` rebuilds engine state on
 * boot (plan/13 §8).
 */
export class PositionsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.positions);
  }

  async upsert(position: Position): Promise<void> {
    const doc = PositionSchema.parse(position);
    await this.collection.updateOne(
      { positionId: doc.positionId },
      { $set: doc },
      { upsert: true },
    );
  }

  async findOpen(): Promise<Position[]> {
    const docs = await this.collection
      .find({ status: "OPEN" }, { projection: { _id: 0 } })
      .toArray();
    return docs.map((doc) => PositionSchema.parse(doc));
  }

  /**
   * Realized PnL summed per strategy for positions opened at/after `since`
   * (the IST-midnight boundary — intraday square-off means today's positions
   * all opened today; a stale carry-over's realized belonged to its own day).
   * Feeds the per-strategy day stats read model (plan/06 §4).
   */
  async sumRealizedByStrategySince(
    since: number,
  ): Promise<Map<string, number>> {
    const rows = await this.collection
      .aggregate([
        { $match: { openedAt: { $gte: since } } },
        { $group: { _id: "$strategyId", total: { $sum: "$realizedPnl" } } },
      ])
      .toArray();
    const result = new Map<string, number>();
    for (const raw of rows) {
      const row = RealizedByStrategyRowSchema.parse(raw);
      result.set(row._id, row.total);
    }
    return result;
  }
}
