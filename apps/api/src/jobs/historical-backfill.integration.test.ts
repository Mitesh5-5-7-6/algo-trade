import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CandlesRepository,
  connectMongo,
  ensureIndexes,
  type MongoConnection,
} from "@neelkanth/db";
import type { Candle } from "@neelkanth/core";
import type { HistoryProvider, HistoryResult } from "@neelkanth/broker";
import { runHistoricalBackfill } from "./historical-backfill.js";
import { closeProbe, STRICT } from "../test-support/infra.js";

/**
 * Task 1.11 — historical and `LIVE_TICK` bars coexist, and no duplicate
 * candles are produced (PLAN.md §6).
 *
 * The unit tests for D3 prove the upsert predicate in isolation, and the job's
 * own tests prove its bookkeeping against a fake store. Neither can prove the
 * claim this task actually makes, because that claim is about **two producers
 * writing the same key in an order nobody controls**, and it is enforced by a
 * unique index and an index-supported predicate inside a single Mongo update.
 * Replace either with an in-memory double and the test passes while proving
 * nothing: the whole failure mode is that an application-side read-then-write
 * lets two writers interleave.
 *
 * So this suite drives the real `CandlesRepository` against real Mongo, with a
 * fake `HistoryProvider` standing in for the vendor — the only part that needs
 * a token, and the only part not under test here.
 */

const IT_DB = "neelkanth_it_backfill";

/** Point a Mongo URI at this suite's isolated database, whatever it named. */
function isolate(uri: string, dbName: string): string {
  const queryAt = uri.indexOf("?");
  const base = queryAt === -1 ? uri : uri.slice(0, queryAt);
  const query = queryAt === -1 ? "" : uri.slice(queryAt);
  const schemeEnd = base.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = base.indexOf("/", authorityStart);
  const authority = pathStart === -1 ? base : base.slice(0, pathStart);
  return `${authority}/${dbName}${query}`;
}

const MONGO_URI = isolate(
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder",
  IT_DB,
);

/**
 * At module scope, not inside `beforeAll`. A guard in a hook's catch block
 * turns a refusal into a silent skip, which is the failure mode Phase 0 spent
 * its time removing: this suite drops its database.
 */
if (!/^neelkanth_(it|ci)_/.test(IT_DB))
  throw new Error(`refusing to run against "${IT_DB}"`);

const SYMBOL = "NSE:BACKFILL-INDEX";
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const ist = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MS;

// 2026-01-05 is a Monday.
const OPEN = ist(2026, 0, 5, 9, 15);
const BAR_MS = 300_000;
const MONDAY = "2026-01-05";

const bar = (
  index: number,
  source: Candle["source"],
  close: number,
): Candle => ({
  symbol: SYMBOL,
  interval: "5m",
  open: 100,
  high: 200,
  low: 50,
  close,
  volume: source === "BROKER_HISTORICAL" ? 5_000 : 1_000,
  ts: OPEN + index * BAR_MS,
  source,
});

/** A provider that returns the broker's version of the same five bars. */
function providerFor(closes: readonly number[]): HistoryProvider {
  const result: HistoryResult = {
    candles: closes.map((close, i) => bar(i, "BROKER_HISTORICAL", close)),
    rejected: [],
    empty: closes.length === 0,
    pagesFetched: 1,
  };
  return { getHistory: () => Promise.resolve(result) };
}

const BROKER_CLOSES = [101, 102, 103, 104, 105];
const LIVE_CLOSES = [901, 902, 903, 904, 905];

let mongo: MongoConnection | undefined;
let repo: CandlesRepository | undefined;
let reachable = false;

beforeAll(async () => {
  try {
    mongo = await connectMongo(MONGO_URI, IT_DB);
    await mongo.db.dropDatabase();
    // The unique (symbol, interval, ts) index is half of what makes "no
    // duplicates" true. Without it the upsert predicate would happily insert
    // a second document for a bar it was not allowed to overwrite.
    await ensureIndexes(mongo.db);
    repo = new CandlesRepository(mongo.db);
    reachable = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (STRICT)
      throw new Error(
        `historical-backfill integration: MongoDB unreachable and ` +
          `REQUIRE_INTEGRATION=1 — ${reason}`,
      );
    process.stderr.write(
      `\n  SKIPPING historical-backfill integration (${String(11)} tests)\n` +
        `  reason: ${reason}\n` +
        `  fix:    docker compose -f docker-compose.test.yml up -d, or set ` +
        `MONGO_URI to a scratch instance\n` +
        `  NOTE:   skipped is not passed.\n\n`,
    );
  }
}, 60_000);

afterAll(async () => {
  await closeProbe(
    mongo === undefined
      ? undefined
      : { reachable: true as const, connection: mongo },
  );
});

beforeEach(async () => {
  if (!reachable || mongo === undefined) return;
  await mongo.db.collection("candles").deleteMany({});
});

/** Every stored bar for the session, ascending. */
async function stored(): Promise<Candle[]> {
  if (repo === undefined) throw new Error("no repository");
  return repo.findRange(SYMBOL, "5m", OPEN, OPEN + 100 * BAR_MS);
}

async function writeLive(closes: readonly number[]): Promise<boolean[]> {
  if (repo === undefined) throw new Error("no repository");
  const applied: boolean[] = [];
  for (const [i, close] of closes.entries())
    applied.push(await repo.upsert(bar(i, "LIVE_TICK", close)));
  return applied;
}

async function runBackfill(provider: HistoryProvider) {
  if (repo === undefined) throw new Error("no repository");
  const repository = repo;
  return runHistoricalBackfill(
    {
      symbols: [SYMBOL],
      interval: "5m",
      fromDate: MONDAY,
      toDate: MONDAY,
    },
    {
      history: provider,
      holidays: new Set<string>(),
      saveCandle: (candle) => repository.upsert(candle as Candle),
    },
  );
}

describe("historical and LIVE_TICK candles in one collection (§1.11)", () => {
  it("stores one document per (symbol, interval, ts) after both producers write", async (ctx) => {
    if (!reachable || mongo === undefined) return ctx.skip();

    await writeLive(LIVE_CLOSES);
    await runBackfill(providerFor(BROKER_CLOSES));

    const docs = await stored();
    expect(docs).toHaveLength(5);

    const keys = docs.map((d) => `${d.symbol}|${d.interval}|${String(d.ts)}`);
    expect(new Set(keys).size).toBe(5);
    // And nothing outside the repository's own view either.
    expect(await mongo.db.collection("candles").countDocuments()).toBe(5);
  });

  /**
   * The direction the whole precedence rule exists for. Our aggregation runs
   * off a feed that can drop ticks; the exchange's consolidated record is
   * better, so a backfill must be able to correct what live trading wrote.
   */
  it("lets a historical bar correct a live one", async (ctx) => {
    if (!reachable) return ctx.skip();

    await writeLive(LIVE_CLOSES);
    const report = await runBackfill(providerFor(BROKER_CLOSES));

    const docs = await stored();
    expect(docs.map((d) => d.close)).toEqual(BROKER_CLOSES);
    expect(docs.every((d) => d.source === "BROKER_HISTORICAL")).toBe(true);
    expect(report.perSymbol.get(SYMBOL)?.stored).toBe(5);
    expect(report.perSymbol.get(SYMBOL)?.superseded).toBe(0);
  });

  /**
   * And the direction that would be silent data loss. A late tick arriving
   * after a backfill must not demote the broker's bar back to our guess.
   */
  it("does not let a live bar demote a historical one", async (ctx) => {
    if (!reachable) return ctx.skip();

    await runBackfill(providerFor(BROKER_CLOSES));
    const applied = await writeLive(LIVE_CLOSES);

    // Every live write is refused — reported as `false`, which is a success.
    expect(applied).toEqual([false, false, false, false, false]);
    const docs = await stored();
    expect(docs.map((d) => d.close)).toEqual(BROKER_CLOSES);
    expect(docs).toHaveLength(5);
  });

  /**
   * The property that makes "no duplicates" meaningful rather than lucky: the
   * final state must not depend on which producer happened to run first. Under
   * last-writer-wins these two orders would disagree.
   */
  it("reaches the same final state in either write order", async (ctx) => {
    if (!reachable || mongo === undefined) return ctx.skip();

    await writeLive(LIVE_CLOSES);
    await runBackfill(providerFor(BROKER_CLOSES));
    const liveFirst = await stored();

    await mongo.db.collection("candles").deleteMany({});

    await runBackfill(providerFor(BROKER_CLOSES));
    await writeLive(LIVE_CLOSES);
    const historicalFirst = await stored();

    expect(historicalFirst).toEqual(liveFirst);
  });

  /**
   * Bars from both producers genuinely coexist — this is not "historical wins
   * everywhere". A session partly covered by a backfill and partly by live
   * aggregation must read back as one coherent ascending series.
   */
  it("returns a single ascending series mixing both sources", async (ctx) => {
    if (!reachable || repo === undefined) return ctx.skip();

    // Live covers the whole session; the backfill only reaches the first three.
    await writeLive(LIVE_CLOSES);
    await runBackfill(providerFor(BROKER_CLOSES.slice(0, 3)));

    const docs = await stored();
    expect(docs).toHaveLength(5);
    expect(docs.map((d) => d.ts)).toEqual(
      [0, 1, 2, 3, 4].map((i) => OPEN + i * BAR_MS),
    );
    expect(docs.map((d) => d.source)).toEqual([
      "BROKER_HISTORICAL",
      "BROKER_HISTORICAL",
      "BROKER_HISTORICAL",
      "LIVE_TICK",
      "LIVE_TICK",
    ]);
    expect(docs.map((d) => d.close)).toEqual([101, 102, 103, 904, 905]);
  });

  it("keeps provenance readable per bar, so a distrusted run can be found", async (ctx) => {
    if (!reachable) return ctx.skip();

    await runBackfill(providerFor(BROKER_CLOSES));
    const docs = await stored();

    for (const doc of docs) {
      expect(doc.source).toBe("BROKER_HISTORICAL");
      expect(doc.volume).toBe(5_000);
    }
  });
});

describe("re-running a backfill (D6)", () => {
  /**
   * D6 calls the job safely re-runnable. Re-running a completed range must be
   * a no-op that rewrites identical values — not a second set of documents,
   * and not a refusal.
   */
  it("is idempotent: the same range twice leaves one document per bar", async (ctx) => {
    if (!reachable || mongo === undefined) return ctx.skip();

    const first = await runBackfill(providerFor(BROKER_CLOSES));
    const after = await stored();
    const second = await runBackfill(providerFor(BROKER_CLOSES));

    expect(await mongo.db.collection("candles").countDocuments()).toBe(5);
    expect(await stored()).toEqual(after);
    expect(second.perSymbol.get(SYMBOL)?.stored).toBe(
      first.perSymbol.get(SYMBOL)?.stored,
    );
  });

  /**
   * A re-run whose values changed — a vendor revision — must land, because
   * equal rank still overwrites. Otherwise a correction could never be applied
   * and the first answer would be permanent.
   */
  it("applies a corrected bar from a later run at the same rank", async (ctx) => {
    if (!reachable) return ctx.skip();

    await runBackfill(providerFor(BROKER_CLOSES));
    await runBackfill(providerFor([111, 112, 113, 114, 115]));

    expect((await stored()).map((d) => d.close)).toEqual([
      111, 112, 113, 114, 115,
    ]);
  });

  it("reports what it stored, and the collection agrees", async (ctx) => {
    if (!reachable || mongo === undefined) return ctx.skip();

    const report = await runBackfill(providerFor(BROKER_CLOSES));
    const row = report.perSymbol.get(SYMBOL);

    expect(row?.stored).toBe(
      await mongo.db.collection("candles").countDocuments(),
    );
    expect(row?.rejected).toBe(0);
    expect(row?.failures).toEqual([]);
    expect(row?.daysWithNoData).toEqual([]);
  });
});

describe("the unique index is what makes this true", () => {
  /**
   * The precedence predicate excludes a better-ranked bar from the filter, so
   * the upsert falls through to an INSERT. Only the unique index stops that
   * becoming a second document for the same bucket — and `upsert` translating
   * that duplicate-key error into `false` is what keeps it a success rather
   * than an unhandled throw.
   *
   * If the index were ever dropped, every test above would still pass while
   * the collection quietly grew two rows per bar.
   */
  it("declares a unique index on (symbol, interval, ts)", async (ctx) => {
    if (!reachable || mongo === undefined) return ctx.skip();

    const indexes = await mongo.db.collection("candles").indexes();
    const unique = indexes.find(
      (index) =>
        index.unique === true &&
        JSON.stringify(index.key) ===
          JSON.stringify({ symbol: 1, interval: 1, ts: 1 }),
    );
    expect(unique).toBeDefined();
  });

  it("refuses a demoting write without throwing", async (ctx) => {
    if (!reachable || repo === undefined) return ctx.skip();

    await repo.upsert(bar(0, "BROKER_HISTORICAL", 101));
    await expect(repo.upsert(bar(0, "LIVE_TICK", 901))).resolves.toBe(false);
    expect((await stored())[0]?.close).toBe(101);
  });
});
