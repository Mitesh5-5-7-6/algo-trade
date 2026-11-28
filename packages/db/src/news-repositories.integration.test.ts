import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DayContext, NewsItem } from "@neelkanth/core";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import {
  COLLECTIONS,
  DayContextsRepository,
  ensureNewsIndexes,
  MarketEventsRepository,
  MorningReadsRepository,
  NewsItemsRepository,
  OvernightMovesRepository,
  type MongoConnection,
} from "./index.js";

/** The day-context pipeline's collections: each write idempotent, by its key. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

const NAMES = [
  COLLECTIONS.newsItems,
  COLLECTIONS.marketEvents,
  COLLECTIONS.overnightMoves,
  COLLECTIONS.morningReads,
  COLLECTIONS.dayContexts,
];

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_news",
    "packages/db/src/news-repositories.integration.test.ts",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureNewsIndexes(connection.db);
});
beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  for (const name of NAMES) await connection.db.collection(name).deleteMany({});
});
afterAll(async () => {
  await closeProbe(probe);
});

const item = (newsId: string, over: Partial<NewsItem> = {}): NewsItem => ({
  newsId,
  source: "economictimes",
  feed: "et-markets",
  url: `https://economictimes.indiatimes.com/x/${newsId}.cms`,
  title: `headline ${newsId}`,
  publishedAt: 1_000,
  ingestedAt: 2_000,
  symbols: [],
  topics: [],
  ...over,
});

describe("NewsItemsRepository", () => {
  it("keeps a headline once; a second sighting changes nothing", async () => {
    const repo = new NewsItemsRepository(connection.db);
    expect(await repo.insert(item("a"))).toBe(true);
    expect(
      await repo.insert(item("a", { title: "rewritten", ingestedAt: 9_000 })),
    ).toBe(false);
    const [kept] = await repo.find({ limit: 10 });
    expect(kept).toMatchObject({ title: "headline a", ingestedAt: 2_000 });
    expect(await repo.insertMany([item("a"), item("b"), item("c")])).toBe(2);
    expect(await repo.insertMany([item("a"), item("b"), item("c")])).toBe(0);
    expect(await repo.count()).toBe(3);
  });

  it("reads newest first, by stock and window, within the limit", async () => {
    const repo = new NewsItemsRepository(connection.db);
    await repo.insertMany([
      item("old", { publishedAt: 100, symbols: ["NSE:SBIN-EQ"] }),
      item("mid", { publishedAt: 200 }),
      item("new", { publishedAt: 300, symbols: ["NSE:SBIN-EQ"] }),
    ]);
    expect((await repo.find({ limit: 10 })).map((n) => n.newsId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(
      (await repo.find({ symbol: "NSE:SBIN-EQ", limit: 10 })).map(
        (n) => n.newsId,
      ),
    ).toEqual(["new", "old"]);
    expect(
      (await repo.find({ from: 150, to: 300, limit: 10 })).map((n) => n.newsId),
    ).toEqual(["mid"]);
    expect((await repo.find({ limit: 1 })).map((n) => n.newsId)).toEqual([
      "new",
    ]);
  });
});

describe("MarketEventsRepository", () => {
  it("loads the calendar again without a second row", async () => {
    const repo = new MarketEventsRepository(connection.db);
    const event = {
      date: "2026-12-04",
      kind: "RBI_POLICY" as const,
      title: "RBI MPC policy decision",
      symbols: [],
      source: "https://www.rbi.org.in/x",
    };
    expect(await repo.upsert(event)).toBe(true);
    expect(await repo.upsert(event)).toBe(false);
    expect(await repo.count()).toBe(1);
    expect(await repo.onDate("2026-12-04")).toEqual([event]);
    expect(await repo.onDate("2026-12-05")).toEqual([]);
  });
});

describe("OvernightMovesRepository", () => {
  it("writes one row per Indian date, the latest fetch winning", async () => {
    const repo = new OvernightMovesRepository(connection.db);
    const move = {
      date: "2026-11-30",
      usDate: "2026-11-27",
      spxChangePct: 1.6,
      ndxChangePct: 2.1,
      source: "yahoo-chart",
    };
    expect(await repo.upsert(move)).toBe(true);
    expect(await repo.upsert(move)).toBe(false);
    expect(await repo.upsert({ ...move, spxChangePct: 1.5 })).toBe(false);
    expect(await repo.count()).toBe(1);
    expect(await repo.forDate("2026-11-30")).toEqual({
      ...move,
      spxChangePct: 1.5,
    });
    expect(await repo.forDate("2026-12-01")).toBeNull();
  });
});

describe("MorningReadsRepository and DayContextsRepository", () => {
  it("keep one row per date, a rebuild replacing it", async () => {
    const reads = new MorningReadsRepository(connection.db);
    const read = {
      date: "2026-11-30",
      at: 5,
      flags: [],
      stockTone: [
        { symbol: "NSE:SBIN-EQ", tone: 1 as const, headlineIds: ["a"] },
      ],
      headlinesRead: 1,
      headlineIds: ["a"],
      ai: { provider: "gemini", model: "m", at: 5 },
      notes: [],
    };
    await reads.save(read);
    await reads.save({ ...read, at: 6 });
    expect(await reads.forDate("2026-11-30")).toEqual({ ...read, at: 6 });

    const contexts = new DayContextsRepository(connection.db);
    const context: DayContext = {
      date: "2026-11-30",
      builtAt: 7,
      events: [],
      overnight: null,
      flags: [],
      stockTone: [],
      headlinesRead: 0,
      ai: null,
      notes: ["no AI key configured"],
    };
    await contexts.save(context);
    await contexts.save({ ...context, builtAt: 8, notes: [] });
    expect(await contexts.forDate("2026-11-30")).toEqual({
      ...context,
      builtAt: 8,
      notes: [],
    });
    expect(
      await connection.db.collection(COLLECTIONS.dayContexts).countDocuments(),
    ).toBe(1);
    expect(await contexts.forDate("2026-12-01")).toBeNull();
  });
});
