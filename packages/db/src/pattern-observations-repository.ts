import type { AnyBulkWriteOperation, Db, Document } from "mongodb";
import {
  PatternObservationSchema,
  toObservation,
  type PatternObservation,
  type PatternOccurrence,
} from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/** Narrowing available on every read. All fields are optional. */
export interface ObservationFilter {
  symbol?: string;
  interval?: string;
  patternId?: string;
  detectorVersion?: string;
  paramsKey?: string;
  direction?: "BULLISH" | "BEARISH";
}

/** One detector definition found in a window, and how often it fired. */
export interface ObservedVersion {
  patternId: string;
  detectorVersion: string;
  paramsKey: string;
  count: number;
}

/**
 * Pattern detections (§5.3) — the second axis of the pattern × strategy matrix.
 *
 * Completed trades say what a decision earned. These say what the market was
 * doing when it was made. Neither is research on its own; joined on symbol and
 * time, they are.
 *
 * **Writes are idempotent and never overwrite.** A sweep re-run over the same
 * day must not double the sample, because sample size is the denominator of
 * every statistic computed downstream — a silent double-count turns a coin flip
 * into a discovery. So a row is inserted once and then left alone.
 *
 * Deliberately no TTL. Same reason as `trades`: evidence that expires is a
 * dataset that shrinks under whoever is studying it (ADR §10.4).
 */
export class PatternObservationsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.patternObservations);
  }

  /**
   * Record one detection if it is not already stored.
   *
   * Returns false when it was already there — which is a success, not an
   * error. A sweep that is re-run is the normal case, not an exception.
   */
  async record(
    occurrence: PatternOccurrence,
    observedAt: number,
  ): Promise<boolean> {
    const doc = toObservation(occurrence, observedAt);
    const result = await this.collection.updateOne(
      identity(doc),
      { $setOnInsert: doc },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  /**
   * Record a batch, returning how many rows were new.
   *
   * One sweep over a year of one symbol is tens of thousands of bars, and a
   * round trip per detection would make the write, not the detection, the cost
   * of research. `ordered: false` so one bad row does not abandon the rest —
   * every row is independent evidence and there is no sequence to preserve.
   */
  async recordMany(
    occurrences: readonly PatternOccurrence[],
    observedAt: number,
  ): Promise<number> {
    if (occurrences.length === 0) return 0;
    const operations: AnyBulkWriteOperation[] = occurrences.map(
      (occurrence) => {
        const doc = toObservation(occurrence, observedAt);
        return {
          updateOne: {
            filter: identity(doc),
            update: { $setOnInsert: doc },
            upsert: true,
          },
        };
      },
    );
    const result = await this.collection.bulkWrite(operations, {
      ordered: false,
    });
    return result.upsertedCount;
  }

  /**
   * Detections in `[fromTs, toTs)`, oldest first.
   *
   * Half-open like the candle and trade ranges, so consecutive periods tile
   * exactly with nothing counted twice at a boundary.
   */
  async findRange(
    fromTs: number,
    toTs: number,
    filter: ObservationFilter = {},
  ): Promise<PatternObservation[]> {
    if (toTs <= fromTs) return [];
    const docs = await this.collection
      .find(
        { ts: { $gte: fromTs, $lt: toTs }, ...criteria(filter) },
        { projection: { _id: 0 } },
      )
      .sort({ ts: 1 })
      .toArray();
    return docs.map((doc) => PatternObservationSchema.parse(doc));
  }

  /**
   * Which detector definitions produced the evidence in a window.
   *
   * §5.1 requires research to be able to ask "under which definition?" and
   * refuse to pool detections from two different rules. That is only an
   * enforceable rule if the question is cheap to ask, so it is a query rather
   * than something a caller is trusted to track.
   */
  async versionsInRange(
    fromTs: number,
    toTs: number,
    filter: ObservationFilter = {},
  ): Promise<ObservedVersion[]> {
    if (toTs <= fromTs) return [];
    const rows = await this.collection
      .aggregate<{ _id: Omit<ObservedVersion, "count">; count: number }>([
        { $match: { ts: { $gte: fromTs, $lt: toTs }, ...criteria(filter) } },
        {
          $group: {
            _id: {
              patternId: "$patternId",
              detectorVersion: "$detectorVersion",
              paramsKey: "$paramsKey",
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.patternId": 1, "_id.detectorVersion": 1 } },
      ])
      .toArray();
    return rows.map((row) => ({ ...row._id, count: row.count }));
  }

  /**
   * Remove detections in a window so they can be recomputed.
   *
   * The one legitimate reason to delete: a candle was revised after ingestion,
   * so everything derived from it is stale (§5.8 — INVALIDATE → RECOMPUTE →
   * NEW RESEARCH VERSION). Without this, `record`'s refusal to overwrite would
   * pin the stale detections forever.
   *
   * This treats an observation as **derived data**, recomputable from the
   * candles and the detector, rather than as a primary record. §5.8's
   * immutability attaches to the research finding that cites observations, not
   * to the observations themselves.
   *
   * **The half of §5.8 this does not deliver:** "which research records
   * depended on this candle?" is still unanswerable, because candles carry no
   * revision counter — only a `source`. Invalidation is therefore a manual,
   * operator-scoped act, not something the system can work out for itself.
   * Recorded as a gap rather than papered over with a counter nothing writes.
   *
   * Returns how many rows were removed.
   */
  async deleteRange(
    fromTs: number,
    toTs: number,
    filter: ObservationFilter = {},
  ): Promise<number> {
    if (toTs <= fromTs) return 0;
    const result = await this.collection.deleteMany({
      ts: { $gte: fromTs, $lt: toTs },
      ...criteria(filter),
    });
    return result.deletedCount;
  }
}

/** The six fields that make a detection one detection. */
function identity(doc: PatternObservation): Document {
  return {
    patternId: doc.patternId,
    detectorVersion: doc.detectorVersion,
    paramsKey: doc.paramsKey,
    symbol: doc.symbol,
    interval: doc.interval,
    ts: doc.ts,
  };
}

/** Only the fields the caller actually set — an absent filter matches all. */
function criteria(filter: ObservationFilter): Document {
  return Object.fromEntries(
    Object.entries(filter).filter(([, value]) => value !== undefined),
  );
}
