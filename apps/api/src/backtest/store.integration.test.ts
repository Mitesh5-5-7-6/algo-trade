import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BacktestsRepository,
  COLLECTIONS,
  ensureIndexes,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { seedCandles } from "../test-support/candles.js";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import { backtestFromStore } from "./store.js";

/** Task 13.2 (design D2): a backtest over the stored bars, kept once, nothing else written. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const INDEX = "NSE:TESTINDEX-INDEX";
const REQUEST = {
  strategyType: "EMA_CROSSOVER",
  params: {},
  symbols: ["NSE:TESTCO-EQ"],
  interval: "5m" as const,
  fromDate: "2026-01-07",
  toDate: "2026-01-09",
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  ...goldenBudget(),
  seed: 0,
  regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
};

beforeAll(async () => {
  probe = await probeMongo(MONGO_URI, "neelkanth_it_backtests", "backtests");
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  await seedCandles(
    connection.db,
    await historicalBars([0, 1, 2, 3, 4], (d) => 1 + (d % 5) * 0.04 + d * 0.01),
  );
}, 120_000);

afterAll(async () => {
  await closeProbe(probe);
});

describe("backtests over the stored bars (13.2)", () => {
  it("keeps a backtest once, with its warm-up lead read, and writes nothing else", async (ctx) => {
    if (probe?.reachable !== true) return ctx.skip();
    const before = (await connection.db.listCollections().toArray())
      .map((c) => c.name)
      .sort();
    const keep = {
      save: true as const,
      backtestId: "bt_1",
      createdAt: 1,
      context: { by: "test" },
    };
    const { backtest, saved } = await backtestFromStore(
      connection.db,
      REQUEST,
      keep,
    );
    expect(saved).toBe(true);
    expect(backtest.metrics.trades).toBeGreaterThan(0);
    const kept = await new BacktestsRepository(connection.db).findById("bt_1");
    expect(kept).toMatchObject({
      backtestId: "bt_1",
      strategyType: "EMA_CROSSOVER",
      window: { fromDate: "2026-01-07", toDate: "2026-01-09" },
      stressed: false,
      fingerprint: backtest.fingerprint,
    });
    // The same request, the same backtest — and an id is never overwritten.
    const again = await backtestFromStore(connection.db, REQUEST, keep);
    expect(again).toMatchObject({
      saved: false,
      backtest: { fingerprint: backtest.fingerprint },
    });
    // A dry run keeps nothing.
    await backtestFromStore(
      connection.db,
      { ...REQUEST, stressed: true },
      { save: false },
    );
    expect(
      await connection.db.collection(COLLECTIONS.backtests).countDocuments(),
    ).toBe(1);
    const after = (await connection.db.listCollections().toArray())
      .map((c) => c.name)
      .sort();
    expect(after).toEqual(before);
  }, 120_000);
});
