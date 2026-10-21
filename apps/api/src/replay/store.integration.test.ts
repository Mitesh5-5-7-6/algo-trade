import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CandlesRepository,
  COLLECTIONS,
  ensureIndexes,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { replayFromStore, type StoredReplayRequest } from "./store.js";
import { runHistoricalReplay } from "./run.js";
import { emaStrategy, goldenBudget, historicalBars } from "./test-support.js";

/**
 * Task 4.7 — a replay never modifies Paper or Live trading state (PLAN.md
 * rule 7, design D3), proved two ways: by what replay code can reach at all,
 * and by running one against real MongoDB beside trading collections that
 * hold data, and finding them byte-identical afterwards.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRADING_REPOSITORIES =
  /\b(Orders|Positions|Trades|Signals|RiskLogs|PnlSnapshots|StrategyState|Settings)Repository\b|COLLECTIONS\.(orders|positions|trades|signals|riskLogs)\b/;

describe("replay code cannot reach trading state (§4.7, D3)", () => {
  /**
   * The structural half: no replay module names a trading repository or
   * collection. The pipeline holds its orders, positions and Trades in memory;
   * the store reads candles and writes replay_runs, and nothing else.
   */
  it("imports no trading repository or collection", () => {
    const files = [
      ...readdirSync(HERE)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(HERE, f)),
      join(HERE, "..", "golden", "pipeline.ts"),
    ];
    const offenders = files.filter((f) =>
      TRADING_REPOSITORIES.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(2); // the scan saw real files
  });
});

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

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

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_replay_store",
    "replay store",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  const candles = new CandlesRepository(connection.db);
  for (const bar of await historicalBars([0, 1])) await candles.upsert(bar);
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
  await connection.db.collection(COLLECTIONS.replayRuns).deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

const request = (
  over: Partial<StoredReplayRequest> = {},
): StoredReplayRequest => ({
  strategy: emaStrategy(),
  symbols: ["NSE:TESTCO-EQ", "NSE:TESTINDEX-INDEX"],
  interval: "5m",
  fromDate: "2026-01-05",
  toDate: "2026-01-06",
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  ...goldenBudget(),
  seed: 7,
  runId: "run_it",
  createdAt: 1_000,
  save: true,
  ...over,
});

describe("a replay over the stored dataset (§4.7, §4.8)", () => {
  it("leaves every trading collection exactly as it found it", async () => {
    const before = await snapshot();
    const { run, saved } = await replayFromStore(connection.db, request());

    expect(run.record.trades.length).toBeGreaterThan(0); // it did trade
    expect(saved).toBe(true);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  /** The store is the pure run plus persistence — it changes no result. */
  it("keeps the run it would have produced in memory", async () => {
    const pure = await runHistoricalReplay({
      ...request(),
      candles: await historicalBars([0, 1]),
    });
    const { run } = await replayFromStore(connection.db, request());

    expect(run.fingerprint).toBe(pure.fingerprint);
    const kept = await connection.db
      .collection(COLLECTIONS.replayRuns)
      .find({}, { projection: { _id: 0 } })
      .toArray();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      runId: "run_it",
      fingerprint: pure.fingerprint,
    });
  }, 60_000);

  it("keeps nothing on a dry run", async () => {
    const { saved } = await replayFromStore(
      connection.db,
      request({ save: false }),
    );
    expect(saved).toBe(false);
    expect(
      await connection.db.collection(COLLECTIONS.replayRuns).countDocuments(),
    ).toBe(0);
  }, 60_000);
});
