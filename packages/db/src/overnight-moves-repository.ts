import type { Db } from "mongodb";
import { OvernightMoveSchema, type OvernightMove } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * The US session that closed before each Indian session opened (operator
 * decision 2026-11-28) — RESEARCH database only. One row per Indian date;
 * fetching the same days again writes the same row.
 */
export class OvernightMovesRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.overnightMoves);
  }

  /** Keeps the move; true when the date was new. */
  async upsert(move: OvernightMove): Promise<boolean> {
    const doc = OvernightMoveSchema.parse(move);
    const result = await this.collection.replaceOne({ date: doc.date }, doc, {
      upsert: true,
    });
    return result.upsertedCount === 1;
  }

  async forDate(date: string): Promise<OvernightMove | null> {
    const doc = await this.collection.findOne(
      { date },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : OvernightMoveSchema.parse(doc);
  }

  async count(): Promise<number> {
    return this.collection.countDocuments();
  }
}
