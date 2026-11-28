import type { Db } from "mongodb";
import { istDateKey, isWeekendIST, type DayContext } from "@neelkanth/core";
import {
  ensureNewsIndexes,
  MarketEventsRepository,
  MorningReadsRepository,
  NewsItemsRepository,
  OvernightMovesRepository,
  type MorningRead,
} from "@neelkanth/db";
import type { ResearchAi } from "../environment.js";
import {
  collectFeeds,
  fetchText as defaultFetchText,
  GOOGLE_SPACING_MS,
  type ErrorSink,
  type FeedResult,
  type FetchText,
} from "./collector.js";
import { buildDayContext } from "./day-context.js";
import { GENERAL_FEEDS, HEAVYWEIGHT_FEEDS } from "./feeds.js";
import { loadMarketEvents, seedMarketEvents } from "./market-events.js";
import {
  readWindowStart,
  runMorningRead,
  type ChatFn,
} from "./morning-read.js";
import { fetchOvernightMoves } from "./overnight.js";
import { NewsScheduler } from "./scheduler.js";

/** The most headlines a morning read loads from the window before selecting. */
const READ_LOAD_LIMIT = 2_000;

export interface NewsServiceDeps {
  db: Db;
  now: () => number;
  ai: ResearchAi;
  onError: ErrorSink;
  /** What each job did, for the log. */
  onInfo?: (detail: Record<string, unknown>, message: string) => void;
  fetchText?: FetchText;
  chat?: ChatFn;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The news and day-context pipeline over the research database: headlines
 * in, the calendar loaded, the overnight move fetched, the morning read
 * taken, the day context built. Every job is safe to run again.
 */
export class NewsService {
  private readonly news: NewsItemsRepository;
  private readonly fetch: FetchText;
  private scheduler: NewsScheduler | null = null;

  constructor(private readonly deps: NewsServiceDeps) {
    this.news = new NewsItemsRepository(deps.db);
    this.fetch = deps.fetchText ?? ((url) => defaultFetchText(url));
  }

  private info(detail: Record<string, unknown>, message: string): void {
    this.deps.onInfo?.(detail, message);
  }

  /** Indexes, and the event calendar loaded; how many events were new. */
  async prepare(): Promise<number> {
    await ensureNewsIndexes(this.deps.db);
    const events = new MarketEventsRepository(this.deps.db);
    return seedMarketEvents(loadMarketEvents(), (e) => events.upsert(e));
  }

  private collect(
    feeds: Parameters<typeof collectFeeds>[0],
    spacingMs: number,
  ): Promise<FeedResult[]> {
    return collectFeeds(feeds, {
      fetchText: this.fetch,
      keep: (items) => this.news.insertMany(items),
      now: this.deps.now,
      onError: this.deps.onError,
      spacingMs,
      ...(this.deps.sleep === undefined ? {} : { sleep: this.deps.sleep }),
      stopped: () => this.scheduler?.isStopped === true,
    });
  }

  /** One pass of the general feeds. */
  async collectGeneral(): Promise<FeedResult[]> {
    const results = await this.collect(GENERAL_FEEDS, 0);
    this.info({ results }, "news: general feeds read");
    return results;
  }

  /** One pass of the per-heavyweight Google News queries, 2 s apart. */
  async collectHeavyweights(): Promise<FeedResult[]> {
    const results = await this.collect(HEAVYWEIGHT_FEEDS, GOOGLE_SPACING_MS);
    this.info({ results }, "news: heavyweight queries read");
    return results;
  }

  /**
   * The US overnight moves: two years when none are stored yet (or asked
   * for), the last five days otherwise. Rebuilds today's context after, so a
   * context built before the fetch picks the move up.
   */
  async updateOvernight(
    options: { backfill?: boolean } = {},
  ): Promise<{ range: "2y" | "5d"; fetched: number; added: number }> {
    const repo = new OvernightMovesRepository(this.deps.db);
    const range =
      options.backfill === true || (await repo.count()) === 0 ? "2y" : "5d";
    let fetched = 0;
    let added = 0;
    try {
      const moves = await fetchOvernightMoves({
        fetchText: this.fetch,
        range,
        now: this.deps.now(),
      });
      fetched = moves.length;
      for (const move of moves) if (await repo.upsert(move)) added += 1;
      this.info({ range, fetched, added }, "news: overnight moves fetched");
    } catch (error) {
      this.deps.onError(error, { where: "overnight", range });
    }
    await this.rebuildToday();
    return { range, fetched, added };
  }

  /**
   * The morning read for a date, kept; the date's context rebuilt with it.
   * Skipped (null) when the date already has a read and `force` is not set.
   */
  async morningRead(
    date: string,
    options: { force?: boolean } = {},
  ): Promise<MorningRead | null> {
    const reads = new MorningReadsRepository(this.deps.db);
    if (options.force !== true && (await reads.forDate(date)) !== null)
      return null;
    if (this.deps.ai.forbidden.length > 0)
      this.deps.onError(new Error(this.deps.ai.note ?? "AI read disabled"), {
        where: "morningRead",
        forbidden: this.deps.ai.forbidden,
      });
    const now = this.deps.now();
    const items = await this.news.find({
      from: readWindowStart(date),
      to: now + 1,
      limit: READ_LOAD_LIMIT,
    });
    const read = await runMorningRead({
      date,
      now,
      items,
      ai: this.deps.ai.ai,
      aiNote: this.deps.ai.note,
      ...(this.deps.chat === undefined ? {} : { chat: this.deps.chat }),
    });
    await reads.save(read);
    this.info(
      {
        date,
        headlinesRead: read.headlinesRead,
        flags: read.flags.length,
        stockTone: read.stockTone.length,
        notes: read.notes,
      },
      "news: morning read kept",
    );
    await buildDayContext(this.deps.db, date, this.deps.now());
    return read;
  }

  /** Builds and keeps the context for a date. */
  context(date: string): Promise<DayContext> {
    return buildDayContext(this.deps.db, date, this.deps.now());
  }

  private async rebuildToday(): Promise<void> {
    const today = istDateKey(this.deps.now());
    if (isWeekendIST(today)) return;
    try {
      await buildDayContext(this.deps.db, today, this.deps.now());
    } catch (error) {
      this.deps.onError(error, { where: "dayContext", date: today });
    }
  }

  /** The minute-tick scheduler over the four jobs, started. */
  startScheduler(): NewsScheduler {
    if (this.scheduler !== null) return this.scheduler;
    this.scheduler = new NewsScheduler({
      now: this.deps.now,
      onError: this.deps.onError,
      jobs: {
        general: async () => {
          await this.collectGeneral();
        },
        heavyweights: async () => {
          await this.collectHeavyweights();
        },
        overnight: async () => {
          await this.updateOvernight();
        },
        morningRead: async () => {
          await this.morningRead(istDateKey(this.deps.now()));
        },
      },
    });
    this.scheduler.start();
    return this.scheduler;
  }

  stopScheduler(): void {
    this.scheduler?.stop();
  }
}
