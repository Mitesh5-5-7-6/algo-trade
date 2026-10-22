import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
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
import { counterfactualFromStore } from "../counterfactual/store.js";
import { pinsFor, type Hypothesis, type HypothesisCell } from "./hypothesis.js";
import { describeFinding } from "./family.js";
import {
  familyReport,
  listHypotheses,
  nextId,
  registerHypothesis,
  testRegistered,
} from "./store.js";
import { hypothesis } from "./test-support.js";

/**
 * Task 7.6 (design D8): hypotheses and their tests kept in
 * strategy_experiments, in the research database — registered once, tested
 * once — and unable to touch trading state.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRADING =
  /\b(Orders|Positions|Trades|Signals|RiskLogs|PnlSnapshots|StrategyState|Settings)Repository\b|COLLECTIONS\.(orders|positions|trades|signals|riskLogs)\b/;

describe("validation code cannot reach trading state (D8)", () => {
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
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
const HOURS = { open: "09:15", close: "15:30", squareOff: "15:12" };
const CELL: HypothesisCell = {
  patternId: "EMA_CROSS",
  strategyType: "EMA_CROSSOVER",
  symbol: "ALL",
  regime: "ALL",
};
let claim: (over?: Partial<Hypothesis>) => Hypothesis;

const SENTINELS: Record<string, Record<string, unknown>> = {
  [COLLECTIONS.orders]: { orderId: "ord_live", status: "FILLED" },
  [COLLECTIONS.trades]: { tradeId: "trd_live", status: "CLOSED" },
  [COLLECTIONS.signals]: { signalId: "sig_live", side: "BUY" },
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
    "neelkanth_it_hypotheses",
    "hypothesis store",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  await seedCandles(
    connection.db,
    await historicalBars([0, 1, 2, 3], (d) => 1 + d * 0.05),
  );
  // Pins read off the in-sample run, as registration would.
  const { run } = await counterfactualFromStore(connection.db, {
    symbols: [SYM],
    indexSymbols: [INDEX],
    interval: "5m",
    fromDate: "2026-01-05",
    toDate: "2026-01-06",
    hours: HOURS,
    ...goldenBudget(),
    seed: 0,
    regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
    experimentId: "x",
    createdAt: 0,
    save: false,
  });
  const pins = pinsFor(run.manifest, CELL);
  claim = (over = {}) =>
    hypothesis({
      cell: CELL,
      inSample: { fromDate: "2026-01-05", toDate: "2026-01-06" },
      outOfSample: { fromDate: "2026-01-07", toDate: "2026-01-08" },
      run: {
        ...hypothesis().run,
        symbols: [SYM],
        indexSymbols: [INDEX],
        hours: HOURS,
        ...goldenBudget(),
      },
      pins,
      ...over,
    });
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

describe("the hypothesis registry (7.6)", () => {
  it("registers a claim once, and refuses the same claim under another id", async () => {
    expect(await nextId(connection.db)).toBe("H-0001");
    await registerHypothesis(connection.db, claim());
    expect(await nextId(connection.db)).toBe("H-0002");
    await expect(registerHypothesis(connection.db, claim())).rejects.toThrow(
      /already registered/,
    );
    await expect(
      registerHypothesis(connection.db, claim({ hypothesisId: "H-0002" })),
    ).rejects.toThrow(/already registered as H-0001/);
    expect(
      (await listHypotheses(connection.db)).map((h) => h.hypothesisId),
    ).toEqual(["H-0001"]);
  }, 60_000);

  it("tests a registered claim once, out of sample, and leaves trading state alone", async () => {
    const before = await snapshot();
    await registerHypothesis(connection.db, claim());
    const t = await testRegistered(connection.db, "H-0001", 5_000);
    expect(t.outOfSample.dateRange).toEqual({
      fromDate: "2026-01-07",
      toDate: "2026-01-08",
    });
    expect(t.outOfSample.verdict).toBe("INSUFFICIENT_SAMPLE"); // two days cannot reach 30 Trades
    await expect(
      testRegistered(connection.db, "H-0001", 6_000),
    ).rejects.toThrow(/tested once/);
    await expect(
      testRegistered(connection.db, "H-0404", 6_000),
    ).rejects.toThrow(/not registered/);
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it("reports a family from what the registry holds, untested members included", async () => {
    await registerHypothesis(connection.db, claim());
    await registerHypothesis(
      connection.db,
      claim({ hypothesisId: "H-0002", threshold: -5 }),
    );
    await testRegistered(connection.db, "H-0001", 5_000);
    const findings = await familyReport(connection.db, "F-test");
    expect(
      findings.map((f) => [f.hypothesisId, f.verdict, f.familySize]),
    ).toEqual([
      ["H-0001", "INSUFFICIENT_SAMPLE", 2],
      ["H-0002", "UNTESTED", 2],
    ]);
    expect(describeFinding(findings[0] as (typeof findings)[0])).toContain(
      "not judged",
    );
  }, 120_000);
});
