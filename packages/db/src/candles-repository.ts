import { MongoServerError, type Db } from "mongodb";
import {
  CANDLE_SOURCE_RANK,
  CandleSchema,
  type Candle,
  type CandleInterval,
} from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/** Mongo's duplicate-key error code. */
const DUPLICATE_KEY = 11000;

/**
 * Candles (plan/07 `candles`): OHLCV bars, append-only with long retention —
 * the substrate for indicator warm-up (plan/18 §4), backtests, and the
 * historical research dataset.
 *
 * The invariant (docs/design/PHASE_1_HISTORICAL_DATA.md D3): **one
 * (symbol, interval, ts) is one canonical candle**, whatever produced it.
 * Provenance records where a bar came from; it never creates a second bar.
 */
export class CandlesRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.candles);
  }

  /**
   * Persist a bar, idempotently, without ever demoting the stored one.
   *
   * Two producers now write the same key — live tick aggregation and the
   * historical backfill — so "last writer wins" would mean the better record
   * survives or not depending on the order jobs happened to run in. Instead
   * each source carries a rank (`CANDLE_SOURCE_RANK`) and a write applies only
   * when it does not lower it: the broker's consolidated bar overwrites ours,
   * ours never overwrites the broker's.
   *
   * `sourceRank` is stored denormalised so the check is an index-supported
   * predicate inside the update, not an application-side read-then-write that
   * two concurrent jobs could interleave.
   *
   * Returns whether the write was applied — `false` means a higher-ranked bar
   * is already stored, which is a success, not an error.
   */
  async upsert(candle: Candle): Promise<boolean> {
    const doc = CandleSchema.parse(candle);
    const rank = CANDLE_SOURCE_RANK[doc.source];
    try {
      const result = await this.collection.updateOne(
        {
          symbol: doc.symbol,
          interval: doc.interval,
          ts: doc.ts,
          // Bars written before provenance existed carry no `sourceRank`, and
          // in Mongo a missing field does not match `$lte`. They are all live
          // aggregations, so treat absence as LIVE_TICK's rank rather than
          // letting every legacy bar fail the predicate and collide below.
          $or: [
            { sourceRank: { $lte: rank } },
            { sourceRank: { $exists: false } },
          ],
        },
        { $set: { ...doc, sourceRank: rank } },
        { upsert: true },
      );
      // matched, not modified: the filter permitted the write and the values
      // were already identical. That is a re-run, which must report as applied
      // — a backfill repeated over the same day is a no-op, not a refusal.
      return result.matchedCount > 0 || result.upsertedCount > 0;
    } catch (error) {
      // The filter excluded a higher-ranked bar, so the upsert tried to INSERT
      // and the unique (symbol, interval, ts) index refused it. That is the
      // precedence rule working: the stored bar is better than this one.
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
        return false;
      }
      throw error;
    }
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

  /**
   * Every bar in `[fromTs, toTs)`, oldest→newest — the query a replay needs to
   * ask for "one trading day", which `loadRecent(limit)` structurally cannot
   * answer (design D4).
   *
   * Half-open on purpose: consecutive day requests then tile exactly, with no
   * bar counted twice at a boundary and none skipped.
   *
   * Served by the existing unique index `{symbol, interval, ts}` — its first
   * two fields are the equality prefix and `ts` the range, so no new index.
   */
  async findRange(
    symbol: string,
    interval: CandleInterval,
    fromTs: number,
    toTs: number,
  ): Promise<Candle[]> {
    if (toTs <= fromTs) return [];
    const docs = await this.collection
      .find(
        { symbol, interval, ts: { $gte: fromTs, $lt: toTs } },
        { projection: { _id: 0 } },
      )
      .sort({ ts: 1 })
      .toArray();
    return docs.map((doc) => CandleSchema.parse(doc));
  }
}
