import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  DEFAULT_GLOBAL_SETTINGS,
  ensureIndexes,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { seedCandles } from "../test-support/candles.js";
import { runSetupOdds } from "./run.js";
import { setupOddsFromStore, type StoredSetupOddsRequest } from "./store.js";
import { orbDay, ORB_DAY_SYMBOL } from "./test-support.js";

/**
 * Design §6.1 D7 — a plan's odds never modify trading state, proved the two
 * ways Phase 4's task 4.7 proved it for the replay: by what the odds code can
 * reach at all, and by a run against real MongoDB beside trading collections
 * that hold data, found identical afterwards.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRADING_REPOSITORIES =
  /\b(Orders|Positions|Trades|Signals|RiskLogs|PnlSnapshots|StrategyState|Settings)Repository\b|COLLECTIONS\.(orders|positions|trades|signals|riskLogs)\b/;

describe("setup-odds code cannot reach trading state (17.6, D7)", () => {
  it("imports no trading repository or collection", () => {
    const files = readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(HERE, f));
    const offenders = files.filter((f) =>
      TRADING_REPOSITORIES.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(4); // the scan saw real files
  });
});

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

/** Four sessions before the plan's day, the plan's day itself, and one after. */
const BEFORE = [
  ...orbDay("2026-03-02", "TARGET"),
  ...orbDay("2026-03-03", "STOP"),
  ...orbDay("2026-03-04", "NEITHER"),
  ...orbDay("2026-03-05", "TARGET"),
];
const FROM_PLAN_DAY = [
  ...orbDay("2026-03-06", "STOP"),
  ...orbDay("2026-03-09", "STOP"),
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

beforeAll(async () => {
  probe = await probeMongo(MONGO_URI, "neelkanth_it_odds_store", "odds store");
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  await seedCandles(connection.db, [...BEFORE, ...FROM_PLAN_DAY]);
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
  await closeProbe(probe);
});

const request = (
  over: Partial<StoredSetupOddsRequest> = {},
): StoredSetupOddsRequest => ({
  plan: {
    symbol: ORB_DAY_SYMBOL,
    side: "LONG",
    entry: 20_080,
    stop: 20_000,
    target: 20_180,
    date: "2026-03-06",
    time: "09:40",
  },
  indexSymbols: [],
  interval: "5m",
  resampling: { replays: 200, seed: 7, window: 0 },
  rule: { type: "ORB", params: {} },
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  allocatedCapital: 1_000_000,
  limits: DEFAULT_GLOBAL_SETTINGS.globalRiskLimits,
  experimentId: "odds_it",
  createdAt: 1_000,
  save: true,
  ...over,
});

describe("a plan's odds over the stored dataset (17.6)", () => {
  it("leaves every trading collection exactly as it found it", async () => {
    const before = await snapshot();
    const { run, saved } = await setupOddsFromStore(connection.db, request());

    expect(run.result.history?.fired).toBeGreaterThan(0); // the rule did trade
    expect(saved).toBe(true);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  /**
   * The store is the pure run plus persistence — and the pure run here is
   * handed only the sessions before the plan's day, while the database also
   * holds the plan's day and the one after: the fingerprints agree only if
   * the store never let those reach the run.
   */
  it("keeps the run it would have produced from the earlier sessions alone", async () => {
    const { indexSymbols, interval, experimentId, createdAt, save, ...rest } =
      request();
    void [indexSymbols, interval, experimentId, createdAt, save];
    const pure = await runSetupOdds({ ...rest, candles: BEFORE });
    const { run } = await setupOddsFromStore(connection.db, request());

    expect(run.fingerprint).toBe(pure.fingerprint);
    expect(run.manifest.pool.dates).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
    const docs = await kept();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      experimentId: "odds_it",
      kind: "SETUP_ODDS",
      createdAt: 1_000,
      fingerprint: pure.fingerprint,
    });
  }, 60_000);

  it("never overwrites a kept run", async () => {
    expect((await setupOddsFromStore(connection.db, request())).saved).toBe(
      true,
    );
    const again = await setupOddsFromStore(
      connection.db,
      request({ resampling: { replays: 200, seed: 8, window: 0 } }),
    );
    expect(again.saved).toBe(false);
    expect(await kept()).toHaveLength(1);
  }, 60_000);

  it("keeps nothing on a dry run", async () => {
    const { saved } = await setupOddsFromStore(
      connection.db,
      request({ save: false }),
    );
    expect(saved).toBe(false);
    expect(await kept()).toHaveLength(0);
  }, 60_000);
});
