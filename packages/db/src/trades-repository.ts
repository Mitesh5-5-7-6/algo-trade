import type { Db } from "mongodb";
import { TradeSchema, type Trade } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * Completed trades (ADR §9.2) — the outcome primitive research labels against.
 *
 * Writes to `trades`, which has **no TTL**. `trade_logs` exists with a 90-day
 * expiry and is deliberately not used: research evidence that expires is a
 * dataset that shrinks under whoever is studying it (ADR §10.4).
 *
 * **Persistence only — no P&L arithmetic lives here.** The Trade Engine owns
 * the lifecycle through `applyTradeFill`, and a second implementation in this
 * class would be a copy that drifts. This repository stores what the engine
 * decided and reads it back.
 */
export class TradesRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.trades);
  }

  /**
   * Persist a trade, new or updated, keyed on `tradeId`.
   *
   * The projection's write path: the engine holds the authoritative state and
   * this records it. An upsert rather than an insert, because a trade is
   * written many times across its life — open, each partial exit, close.
   */
  async save(trade: Trade): Promise<void> {
    const doc = TradeSchema.parse(trade);
    await this.collection.updateOne(
      { tradeId: doc.tradeId },
      { $set: doc },
      { upsert: true },
    );
  }

  /**
   * Record a trade only if it is not already there.
   *
   * Idempotent on `tradeId`. Returns false when the trade already existed, so
   * a caller can tell "recorded" from "already knew".
   */
  async open(trade: Trade): Promise<boolean> {
    const doc = TradeSchema.parse(trade);
    const result = await this.collection.updateOne(
      { tradeId: doc.tradeId },
      { $setOnInsert: doc },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  /** The open trade for a strategy and symbol, or null. */
  async findOpen(strategyId: string, symbol: string): Promise<Trade | null> {
    const doc = await this.collection.findOne(
      { status: "OPEN", strategyId, symbol },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : TradeSchema.parse(doc);
  }

  /** Every open trade — for hydrating the Trade Engine at boot. */
  async findAllOpen(): Promise<Trade[]> {
    const docs = await this.collection
      .find({ status: "OPEN" }, { projection: { _id: 0 } })
      .toArray();
    return docs.map((doc) => TradeSchema.parse(doc));
  }

  /**
   * Trades entered in `[fromTs, toTs)`, oldest first — the research query.
   *
   * Half-open like the candle range, so consecutive periods tile exactly with
   * no trade counted twice at a boundary.
   */
  async findRange(
    fromTs: number,
    toTs: number,
    filter: { strategyId?: string; symbol?: string } = {},
  ): Promise<Trade[]> {
    if (toTs <= fromTs) return [];
    const docs = await this.collection
      .find(
        {
          entryTime: { $gte: fromTs, $lt: toTs },
          ...(filter.strategyId === undefined
            ? {}
            : { strategyId: filter.strategyId }),
          ...(filter.symbol === undefined ? {} : { symbol: filter.symbol }),
        },
        { projection: { _id: 0 } },
      )
      .sort({ entryTime: 1 })
      .toArray();
    return docs.map((doc) => TradeSchema.parse(doc));
  }

  /** The most recent trades, newest first — the operator's read model. */
  async findRecent(limit: number): Promise<Trade[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ entryTime: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => TradeSchema.parse(doc));
  }
}
