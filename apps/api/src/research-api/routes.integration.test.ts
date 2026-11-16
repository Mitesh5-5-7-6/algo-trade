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
