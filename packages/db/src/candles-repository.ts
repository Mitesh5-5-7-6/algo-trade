import type { Db } from "mongodb";
import {
  CandleSchema,
  type Candle,
  type CandleInterval,
} from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * Candles (plan/07 `candles`): OHLCV bars, append-only with long retention —
 * the substrate for indicator warm-up (plan/18 §4) and backtests. Upsert by
 * the unique (symbol, interval, ts) key so re-persisting a bar is idempotent.
 */
export class CandlesRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.candles);
  }

  async upsert(candle: Candle): Promise<void> {
    const doc = CandleSchema.parse(candle);
    await this.collection.updateOne(
      { symbol: doc.symbol, interval: doc.interval, ts: doc.ts },
      { $set: doc },
      { upsert: true },
    );
  }

  /** The last `limit` bars for warm-up, oldest→newest (plan/18 §4). */
  async loadRecent(
    symbol: string,
    interval: CandleInterval,
    limit: number,
  ): Promise<Candle[]> {
    const docs = await this.collection
      .find({ symbol, interval }, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => CandleSchema.parse(doc)).reverse();
  }
}
