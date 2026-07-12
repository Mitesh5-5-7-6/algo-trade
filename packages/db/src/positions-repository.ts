import type { Db } from "mongodb";
import { PositionSchema, type Position } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

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
}
