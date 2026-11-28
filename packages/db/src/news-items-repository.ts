import type { Db } from "mongodb";
import { NewsItemSchema, type NewsItem } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/** The most rows one read returns, whatever the caller asks for. */
const MAX_READ = 5_000;

export interface NewsQuery {
  /** Only headlines naming this heavyweight, e.g. "NSE:HDFCBANK-EQ". */
  symbol?: string;
  /** Published at or after, epoch ms. */
  from?: number;
  /** Published before, epoch ms. */
  to?: number;
  limit: number;
}

/**
 * Headlines as collected (operator decision 2026-11-28) — RESEARCH database
 * only. The title and the link, never the article, each with the feed it came
 * from. One row per canonical URL: a headline seen again by a later pass, or
 * by a second feed, is ignored rather than rewritten, so its first sighting
 * stands. Untimed — unlike the 30-day `news` collection, this is evidence a
 * later study reads.
 */
export class NewsItemsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.newsItems);
  }

  /** Keeps the headline; false when it was already kept. */
  async insert(item: NewsItem): Promise<boolean> {
    const doc = NewsItemSchema.parse(item);
    const result = await this.collection.updateOne(
      { newsId: doc.newsId },
      { $setOnInsert: { ...doc } },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  }

  /** Keeps every headline not already kept; how many were new. */
  async insertMany(items: readonly NewsItem[]): Promise<number> {
    if (items.length === 0) return 0;
    const docs = items.map((item) => NewsItemSchema.parse(item));
    const result = await this.collection.bulkWrite(
      docs.map((doc) => ({
        updateOne: {
          filter: { newsId: doc.newsId },
          update: { $setOnInsert: { ...doc } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return result.upsertedCount;
  }

  /** Headlines newest first, by symbol and publication window. */
  async find(query: NewsQuery): Promise<NewsItem[]> {
    const publishedAt: Record<string, number> = {};
    if (query.from !== undefined) publishedAt["$gte"] = query.from;
    if (query.to !== undefined) publishedAt["$lt"] = query.to;
    const filter: Record<string, unknown> = {};
    if (query.symbol !== undefined) filter["symbols"] = query.symbol;
    if (Object.keys(publishedAt).length > 0)
      filter["publishedAt"] = publishedAt;
    const docs = await this.collection
      .find(filter, { projection: { _id: 0 } })
      .sort({ publishedAt: -1, newsId: 1 })
      .limit(Math.max(1, Math.min(query.limit, MAX_READ)))
      .toArray();
    return docs.map((doc) => NewsItemSchema.parse(doc));
  }

  async count(): Promise<number> {
    return this.collection.countDocuments();
  }
}
