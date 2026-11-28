import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@neelkanth/logger";
import {
  COLLECTIONS,
  DEFAULT_GLOBAL_SETTINGS,
  ensureIndexes,
  type MongoConnection,
} from "@neelkanth/db";
import { runSetupOdds } from "../odds/run.js";
import { orbDay, ORB_DAY_SYMBOL } from "../odds/test-support.js";
import { buildServer, type ApiServer } from "../server.js";
import { seedCandles } from "../test-support/candles.js";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { runScan } from "../scanner/scan.js";
import {
  cashRow,
  dailyBreakout,
  dailySeries,
  futureRow,
} from "../scanner/test-support.js";
import { buildUniverse } from "../scanner/universe.js";
import { registerResearchRoutes } from "./routes.js";

/**
 * Task 17.8 (design §6.1 D16): the research service answers a plan's odds
 * over HTTP, to a caller holding the shared secret, and to no one else —
 * with the numbers the pure run gives, and trading state untouched.
 */

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
const TOKEN = "s3cret-".repeat(6);
const AUTH = { authorization: `Bearer ${TOKEN}` };
let probe: MongoProbe | undefined;
let connection: MongoConnection;
let app: ApiServer;

const BEFORE = [
  ...orbDay("2026-03-02", "TARGET"),
  ...orbDay("2026-03-03", "STOP"),
  ...orbDay("2026-03-04", "NEITHER"),
  ...orbDay("2026-03-05", "TARGET"),
];

/** One document in each trading collection, so "unchanged" means something. */
const SENTINELS: Record<string, Record<string, unknown>> = {
  [COLLECTIONS.orders]: { orderId: "ord_live", status: "FILLED" },
  [COLLECTIONS.positions]: { positionId: "pos_live", status: "OPEN" },
  [COLLECTIONS.trades]: { tradeId: "trd_live", status: "CLOSED" },
  [COLLECTIONS.signals]: { signalId: "sig_live", side: "BUY" },
  [COLLECTIONS.riskLogs]: { signalId: "sig_live", decision: "approved" },
};

async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of Object.keys(SENTINELS)) {
    out[name] = await connection.db
      .collection(name)
      .find({}, { projection: { _id: 0 } })
      .toArray();
  }
  return out;
}

const kept = () =>
  connection.db
    .collection(COLLECTIONS.strategyExperiments)
    .find({}, { projection: { _id: 0 } })
    .toArray();

const PLAN = {
  symbol: ORB_DAY_SYMBOL,
  side: "LONG",
  entry: 20_080,
  stop: 20_000,
  target: 20_180,
  date: "2026-03-06",
  time: "09:40",
} as const;
const BODY = {
  ...PLAN,
  rule: { type: "ORB" },
  replays: 200,
  seed: 7,
  window: 0,
};

/**
 * The scan's world (18.5): two stock underlyings, RELIANCE breaking out on
 * Monday 2026-11-16 and INFY flat, plus a RELIANCE bar of the scan day
 * itself — which a pre-open scan for 2026-11-17 must never see.
 */
const DATA_DAY = Date.UTC(2026, 10, 16);
const SCAN_BARS = [
  ...dailyBreakout("NSE:RELIANCE-EQ", DATA_DAY),
  ...dailySeries("NSE:INFY-EQ", 40, DATA_DAY),
  ...dailySeries("NSE:RELIANCE-EQ", 1, Date.UTC(2026, 10, 17), {
    close: 50,
    low: 49,
    open: 50,
    high: 51,
  }),
];
const EXPIRY = Date.UTC(2026, 10, 24, 10);
const SYMBOL_FILES = {
  fo: [
    futureRow("RELIANCE", EXPIRY, 500, "10100000002885"),
    futureRow("INFY", EXPIRY, 400, "10100000001594"),
  ].join("\n"),
  cm: [
    cashRow("10100000002885", "RELIANCE", "NSE:RELIANCE-EQ"),
    cashRow("10100000001594", "INFY", "NSE:INFY-EQ"),
  ].join("\n"),
};

const post = (payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({
    method: "POST",
    url: "/odds",
    headers,
    payload: payload as object,
  });

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_research_api",
    "research api",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  await seedCandles(connection.db, [
    ...BEFORE,
    ...orbDay("2026-03-06", "STOP"), // the plan's own day
    ...SCAN_BARS,
  ]);
  app = buildServer({
    logger: createLogger({
      level: "fatal",
      name: "test",
      destination: {
        write() {
          return true;
        },
      },
    }),
    readinessChecks: [],
  });
  registerResearchRoutes(app, {
    db: connection.db,
    token: TOKEN,
    now: () => 5_000,
    symbolFiles: () => Promise.resolve(SYMBOL_FILES),
    calendar: {
      source: "test",
      holidays: new Set(),
      specialSessions: new Set(),
    },
  });
  await app.ready();
}, 120_000);

beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  for (const [name, doc] of Object.entries(SENTINELS)) {
    await connection.db.collection(name).deleteMany({});
    await connection.db.collection(name).insertOne({ ...doc });
  }
  await connection.db
    .collection(COLLECTIONS.strategyExperiments)
    .deleteMany({});
});

afterAll(async () => {
  if (probe?.reachable === true) await app.close();
  await closeProbe(probe);
});

describe("the research service's routes (17.8)", () => {
  it("answers no one without the shared secret, but says it is alive", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { authorization: TOKEN }, // the secret without its scheme
      { authorization: `Bearer ${TOKEN}x` },
    ]) {
      const odds = await post(BODY, headers);
      expect(odds.statusCode).toBe(401);
      expect(odds.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
      const coverage = await app.inject({
        method: "GET",
        url: "/odds/coverage",
        headers,
      });
      expect(coverage.statusCode).toBe(401);
    }
    expect(await kept()).toHaveLength(0);
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
  }, 60_000);

  it("gives the odds the pure run gives, and keeps nothing unless asked", async () => {
    const before = await snapshot();
    const response = await post(BODY);
    expect(response.statusCode).toBe(200);

    const pure = await runSetupOdds({
      plan: PLAN,
      candles: BEFORE,
      resampling: { replays: 200, seed: 7, window: 0 },
      rule: { type: "ORB", params: {} },
      hours: DEFAULT_GLOBAL_SETTINGS.marketHours,
      allocatedCapital: 1_000_000,
      limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
    });
    const body = response.json<{
      experimentId: string | null;
      saved: boolean;
      fingerprint: string;
      result: { history: { fired: number } | null };
    }>();
    expect(body).toMatchObject({
      experimentId: null,
      saved: false,
      fingerprint: pure.fingerprint,
    });
    expect(body.result.history?.fired).toBe(4);
    expect(await kept()).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("keeps the run when asked, beside the other experiments and nowhere else", async () => {
    const before = await snapshot();
    const response = await post({ ...BODY, save: true });
    expect(response.json()).toMatchObject({
      experimentId: "odds_5000",
      saved: true,
    });
    const docs = await kept();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      experimentId: "odds_5000",
      kind: "SETUP_ODDS",
      createdAt: 5_000,
    });
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("answers a plan it cannot compute as the request's fault, in words", async () => {
    for (const [over, words] of [
      [{ stop: 20_100 }, /stop must be below its entry/],
      [{ date: "2026-03-02" }, /no full session/],
      [{ time: "09:10" }, /before the first bar/],
      [{ rule: { type: "NO_SUCH_RULE" } }, /NO_SUCH_RULE/],
      [{ replays: 1_000_000 }, /replays/],
      [{ side: "BUY" }, /side/],
      [{ surprise: true }, /surprise/],
    ] as const) {
      const response = await post({ ...BODY, ...over });
      expect(response.statusCode, JSON.stringify(over)).toBe(400);
      const body = response.json<{
        error: { code: string; message: string };
      }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toMatch(words);
    }
    expect((await post(undefined)).statusCode).toBe(400);
  }, 60_000);

  it("says what the store holds", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/odds/coverage",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        symbol: ORB_DAY_SYMBOL,
        bars: 375,
        firstDate: "2026-03-02",
        lastDate: "2026-03-06",
      },
    ]);
  }, 60_000);
});

describe("the research service's scan (18.5)", () => {
  const scan = (payload: unknown, headers: Record<string, string> = AUTH) =>
    app.inject({
      method: "POST",
      url: "/scan",
      headers,
      payload: payload as object,
    });

  it("answers no one without the shared secret", async () => {
    expect((await scan({ date: "2026-11-17" }, {})).statusCode).toBe(401);
    const coverage = await app.inject({ method: "GET", url: "/scan/coverage" });
    expect(coverage.statusCode).toBe(401);
  }, 60_000);

  it("gives the scan the pure run gives, blind to the scan day, and keeps nothing unless asked", async () => {
    const before = await snapshot();
    const response = await scan({ date: "2026-11-17" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      saved: boolean;
      fingerprint: string;
      result: {
        dataDate: string;
        status: string;
        candidates: { underlying: string; close: number; dataTime: number }[];
        rejected: { underlying: string; reason: string }[];
      };
    }>();

    // The pure scan over only the bars before the scan day.
    const universe = buildUniverse(SYMBOL_FILES, {
      asOf: Date.UTC(2026, 10, 17, 3, 30),
      minDaysToExpiry: 2,
    });
    const before17 = SCAN_BARS.filter(
      (c) => c.ts < Date.UTC(2026, 10, 16, 18, 30),
    );
    const pure = runScan({
      scanDate: "2026-11-17",
      members: universe.members,
      universeRejected: universe.rejected,
      barsBySymbol: new Map(
        ["NSE:RELIANCE-EQ", "NSE:INFY-EQ"].map((s) => [
          s,
          before17.filter((c) => c.symbol === s),
        ]),
      ),
    });
    expect(body.fingerprint).toBe(pure.fingerprint);
    expect(body.saved).toBe(false);
    expect(body.result.dataDate).toBe("2026-11-16");
    expect(body.result.status).toBe("PARTIAL");
    // Judged on Monday's breakout close, not the scan day's 50.
    expect(body.result.candidates).toMatchObject([
      { underlying: "RELIANCE", close: 110, dataTime: DATA_DAY },
    ]);
    expect(body.result.rejected).toMatchObject([
      { underlying: "INFY", reason: "NO_CONDITION" },
    ]);
    expect(await kept()).toHaveLength(0);
    expect(await snapshot()).toEqual(before);

    // Twice, identical (18.6).
    expect((await scan({ date: "2026-11-17" })).json()).toEqual(body);
  }, 60_000);

  it("keeps the run when asked, as a SCAN experiment and nowhere else", async () => {
    const before = await snapshot();
    const response = await scan({ date: "2026-11-17", save: true });
    expect(response.json()).toMatchObject({
      experimentId: "scan_5000",
      saved: true,
    });
    const docs = await kept();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      experimentId: "scan_5000",
      kind: "SCAN",
      manifest: { minDaysToExpiry: 2, universeVersion: "1" },
    });
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("refuses a day the exchange is shut, and a request it does not know", async () => {
    for (const [payload, words] of [
      [{ date: "2026-11-15" }, /not a trading day/],
      [{ date: "17-11-2026" }, /YYYY-MM-DD/],
      [{ date: "2026-11-17", minDaysToExpiry: 99 }, /minDaysToExpiry/],
      [{ date: "2026-11-17", surprise: true }, /surprise/],
    ] as const) {
      const response = await scan(payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(
        response.json<{ error: { message: string } }>().error.message,
      ).toMatch(words);
    }
  }, 60_000);

  it("says which daily bars the store holds", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/scan/coverage",
      headers: AUTH,
    });
    // 40 weekdays back from Monday 2026-11-16 starts on Tuesday 2026-09-22.
    expect(response.json()).toEqual([
      {
        symbol: "NSE:INFY-EQ",
        bars: 40,
        firstDate: "2026-09-22",
        lastDate: "2026-11-16",
      },
      {
        symbol: "NSE:RELIANCE-EQ",
        bars: 41,
        firstDate: "2026-09-22",
        lastDate: "2026-11-17",
      },
    ]);
  }, 60_000);
});

describe("the research service's day context and headlines (operator decision 2026-11-28)", () => {
  const get = (url: string, headers: Record<string, string> = AUTH) =>
    app.inject({ method: "GET", url, headers });
  const headline = (
    newsId: string,
    publishedAt: number,
    symbols: string[],
  ) => ({
    newsId,
    source: "economictimes",
    feed: "et-markets",
    url: `https://economictimes.indiatimes.com/${newsId}.cms`,
    title: `headline ${newsId}`,
    publishedAt,
    ingestedAt: publishedAt,
    symbols,
    topics: [],
  });

  beforeEach(async () => {
    if (probe?.reachable !== true) return;
    for (const name of [
      COLLECTIONS.newsItems,
      COLLECTIONS.marketEvents,
      COLLECTIONS.overnightMoves,
      COLLECTIONS.morningReads,
      COLLECTIONS.dayContexts,
    ])
      await connection.db.collection(name).deleteMany({});
  });

  it("answers no one without the shared secret", async () => {
    for (const url of ["/day-context?date=2026-12-10", "/news"]) {
      const response = await get(url, { authorization: "Bearer wrong" });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("builds a date's context on demand from what is stored, and keeps it", async () => {
    await connection.db.collection(COLLECTIONS.marketEvents).insertOne({
      date: "2026-12-10",
      kind: "FOMC",
      title: "US FOMC decision of Wed 2026-12-09",
      symbols: [],
      source: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    });
    await connection.db.collection(COLLECTIONS.overnightMoves).insertOne({
      date: "2026-12-10",
      usDate: "2026-12-09",
      spxChangePct: -1.2,
      ndxChangePct: -1.8,
      source: "yahoo-chart",
    });
    const response = await get("/day-context?date=2026-12-10");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      date: "2026-12-10",
      builtAt: 5_000,
      events: [
        {
          date: "2026-12-10",
          kind: "FOMC",
          title: "US FOMC decision of Wed 2026-12-09",
          symbols: [],
          source:
            "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
        },
      ],
      overnight: {
        date: "2026-12-10",
        usDate: "2026-12-09",
        spxChangePct: -1.2,
        ndxChangePct: -1.8,
        source: "yahoo-chart",
      },
      flags: [],
      stockTone: [],
      headlinesRead: 0,
      ai: null,
      notes: ["no morning read stored for 2026-12-10"],
    });
    expect(
      await connection.db
        .collection(COLLECTIONS.dayContexts)
        .countDocuments({ date: "2026-12-10" }),
    ).toBe(1);
    // A date with nothing stored is empty, and says why.
    const bare = await get("/day-context?date=2026-12-11");
    expect(bare.json<{ notes: string[] }>().notes).toEqual([
      "no US overnight move stored for 2026-12-11 (Yahoo not fetched or did not answer, or a US holiday)",
      "no morning read stored for 2026-12-11",
    ]);
    expect((await get("/day-context?date=11-12-2026")).statusCode).toBe(400);
    expect((await get("/day-context?day=2026-12-11")).statusCode).toBe(400);
  });

  it("lists headlines newest first, by stock and IST window, 200 at most", async () => {
    const at = (iso: string) => Date.parse(iso);
    await connection.db.collection(COLLECTIONS.newsItems).insertMany([
      headline("a", at("2026-11-26T04:00:00Z"), ["NSE:SBIN-EQ"]),
      headline("b", at("2026-11-27T04:00:00Z"), []),
      headline("c", at("2026-11-27T20:00:00Z"), ["NSE:SBIN-EQ"]), // 28 Nov 01:30 IST
    ]);
    const ids = async (url: string) =>
      (await get(url)).json<{ newsId: string }[]>().map((n) => n.newsId);
    expect(await ids("/news")).toEqual(["c", "b", "a"]);
    expect(await ids("/news?symbol=NSE:SBIN-EQ")).toEqual(["c", "a"]);
    expect(await ids("/news?from=2026-11-27&to=2026-11-27")).toEqual(["b"]);
    expect(
      await ids(`/news?from=${String(at("2026-11-27T00:00:00Z"))}`),
    ).toEqual(["c", "b"]);
    expect(await ids("/news?limit=1")).toEqual(["c"]);
    expect((await get("/news?limit=201")).statusCode).toBe(400);
    expect((await get("/news?symbol=")).statusCode).toBe(400);
    expect((await get("/news")).json<object[]>()[0]).not.toHaveProperty("_id");
  });
});
