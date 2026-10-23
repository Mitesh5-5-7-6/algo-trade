import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  ensureIndexes,
  StrategyCandidatesRepository,
  WalkForwardResultsRepository,
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
import { coveredSessions, walkForwardFromStore } from "./walk-forward-store.js";

/** Task 13.4 (design D4, D5): a candidate walked forward over the stored bars, kept. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
const SETTINGS = {
  interval: "5m" as const,
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  ...goldenBudget(),
  seed: 0,
  regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
  minTrainingTrades: 10,
};

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_walk_forward",
    "walk-forward",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  const offsets: number[] = [];
  for (let d = -4; d <= 176; d += 1) {
    const day = new Date(Date.UTC(2026, 0, 5 + d)).getUTCDay();
    if (day !== 0 && day !== 6) offsets.push(d);
  }
  await seedCandles(
    connection.db,
    await historicalBars(offsets, (d) => 1 + (d % 7) * 0.03 + (d % 11) * 0.01),
  );
  await new StrategyCandidatesRepository(connection.db).save({
    candidateId: "SC-0001",
    createdAt: 1,
    strategyType: "EMA_CROSSOVER",
    grid: [{}, { fast: 5, slow: 13 }],
    symbols: [SYM],
    hypothesisId: "H-0001",
    statement: "EMA_CROSSOVER, as configured or faster",
    fingerprint: "c".repeat(64),
  });
}, 300_000);

afterAll(async () => {
  await closeProbe(probe);
});

describe("walk-forward over the stored bars (13.4)", () => {
  it("finds the sessions every instrument covers", async (ctx) => {
    if (probe?.reachable !== true) return ctx.skip();
    expect(await coveredSessions(connection.db, [SYM, INDEX], "5m")).toEqual({
      first: "2026-01-01",
      last: "2026-06-30",
    });
    expect(
      await coveredSessions(connection.db, ["NSE:NONE-EQ"], "5m"),
    ).toBeNull();
  });

  it("walks the candidate forward, keeps the result and every backtest behind it, once", async (ctx) => {
    if (probe?.reachable !== true) return ctx.skip();
    const dry = await walkForwardFromStore(connection.db, "SC-0001", SETTINGS, {
      save: false,
    });
    expect(dry.saved).toBe(false);
    expect(
      await connection.db
        .collection(COLLECTIONS.walkForwardResults)
        .countDocuments(),
    ).toBe(0);

    const keep = { save: true as const, walkForwardId: "wf_1", createdAt: 9 };
    const { result, saved } = await walkForwardFromStore(
      connection.db,
      "SC-0001",
      SETTINGS,
      keep,
    );
    expect(saved).toBe(true);
    expect(result.fingerprint).toBe(dry.result.fingerprint);
    expect(result.folds.map((f) => f.test.fromDate)).toEqual([
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
    expect(
      await new WalkForwardResultsRepository(connection.db).findById("wf_1"),
    ).toMatchObject({
      candidateId: "SC-0001",
      fingerprint: result.fingerprint,
    });
    // Every backtest behind it: per fold, each variant on training, the baseline, and — when one was chosen — the test, normal and stressed.
    const expected = result.folds.reduce(
      (n, f) => n + f.training.length + 1 + (f.chosen === null ? 0 : 2),
      0,
    );
    expect(
      await connection.db
        .collection(COLLECTIONS.backtests)
        .countDocuments({ "context.walkForwardId": "wf_1" }),
    ).toBe(expected);

    const again = await walkForwardFromStore(
      connection.db,
      "SC-0001",
      SETTINGS,
      keep,
    );
    expect(again.saved).toBe(false);
    expect(
      await connection.db
        .collection(COLLECTIONS.walkForwardResults)
        .countDocuments(),
    ).toBe(1);
  }, 600_000);

  it("refuses a candidate it does not have", async (ctx) => {
    if (probe?.reachable !== true) return ctx.skip();
    await expect(
      walkForwardFromStore(connection.db, "SC-0404", SETTINGS, { save: false }),
    ).rejects.toThrow(/no candidate SC-0404/);
  });
});
