import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CandlesRepository,
  COLLECTIONS,
  ensureIndexes,
  StrategyExperimentsRepository,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "./regime.js";
import { runCounterfactual } from "./run.js";
import {
  counterfactualFromStore,
  type StoredCounterfactualRequest,
} from "./store.js";

/**
 * Task 6.6 (design D7): a counterfactual run over the stored dataset, kept in
 * `strategy_experiments` in the research database — and unable to touch
 * trading state, proved structurally and against real MongoDB.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRADING =
  /\b(Orders|Positions|Trades|Signals|RiskLogs|PnlSnapshots|StrategyState|Settings)Repository\b|COLLECTIONS\.(orders|positions|trades|signals|riskLogs)\b/;

describe("counterfactual code cannot reach trading state (D7)", () => {
  it("imports no trading repository or collection", () => {
    const files = readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(HERE, f));
    expect(files.length).toBeGreaterThan(4);
    expect(files.filter((f) => TRADING.test(readFileSync(f, "utf8")))).toEqual(
      [],
    );
  });
});

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const DAYS = [0, 1, 2];
const scale = (d: number): number => 1 + d * 0.07;

const SENTINELS: Record<string, Record<string, unknown>> = {
  [COLLECTIONS.orders]: { orderId: "ord_live", status: "FILLED" },
  [COLLECTIONS.positions]: { positionId: "pos_live", status: "OPEN" },
  [COLLECTIONS.trades]: { tradeId: "trd_live", status: "CLOSED" },
  [COLLECTIONS.signals]: { signalId: "sig_live", side: "BUY" },
  [COLLECTIONS.riskLogs]: { signalId: "sig_live", decision: "approved" },
};
async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of Object.keys(SENTINELS))
    out[name] = await connection.db
      .collection(name)
      .find({}, { projection: { _id: 0 } })
      .toArray();
  return out;
}

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_counterfactual",
    "counterfactual store",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  const candles = new CandlesRepository(connection.db);
  for (const bar of await historicalBars(DAYS, scale))
    await candles.upsert(bar);
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

const INDEX = "NSE:TESTINDEX-INDEX";
const request = (
  over: Partial<StoredCounterfactualRequest> = {},
): StoredCounterfactualRequest => ({
  symbols: ["NSE:TESTCO-EQ"],
  indexSymbols: [INDEX],
  interval: "5m",
  fromDate: "2026-01-05",
  toDate: "2026-01-07",
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  ...goldenBudget(),
  seed: 7,
  regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
  experimentId: "cf_it",
  createdAt: 1_000,
  save: true,
  ...over,
});

describe("a counterfactual run over the stored dataset (6.6)", () => {
  it("keeps the run it would have produced in memory, and leaves trading state alone", async () => {
    const before = await snapshot();
    const { run, saved } = await counterfactualFromStore(
      connection.db,
      request(),
    );
    const pure = await runCounterfactual({
      symbols: ["NSE:TESTCO-EQ"],
      candles: await historicalBars(DAYS, scale),
      hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
      ...goldenBudget(),
      seed: 7,
      regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
    });

    expect(saved).toBe(true);
    expect(run.fingerprint).toBe(pure.fingerprint);
    const kept = await new StrategyExperimentsRepository(
      connection.db,
    ).findById("cf_it");
    expect(kept).toMatchObject({
      kind: "COUNTERFACTUAL",
      fingerprint: pure.fingerprint,
      createdAt: 1_000,
    });
    expect((kept?.result["matrix"] as unknown[]).length).toBe(
      pure.matrix.length,
    );
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it("keeps nothing on a dry run, and refuses to overwrite a kept one", async () => {
    expect(
      (await counterfactualFromStore(connection.db, request({ save: false })))
        .saved,
    ).toBe(false);
    expect(
      await connection.db
        .collection(COLLECTIONS.strategyExperiments)
        .countDocuments(),
    ).toBe(0);
    await counterfactualFromStore(connection.db, request());
    expect(
      (
        await counterfactualFromStore(
          connection.db,
          request({ createdAt: 2_000 }),
        )
      ).saved,
    ).toBe(false);
    expect(
      await connection.db
        .collection(COLLECTIONS.strategyExperiments)
        .countDocuments(),
    ).toBe(1);
  }, 120_000);
});
