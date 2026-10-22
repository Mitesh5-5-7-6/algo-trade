import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureIndexes,
  StrategyExperimentsRepository,
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
import { runDailyResearch } from "../research/store.js";
import type { HypothesisTest } from "../validation/gate.js";
import { hypothesisFingerprint } from "../validation/hypothesis.js";
import { hypothesis } from "../validation/test-support.js";
import { indexResearch } from "./indexer.js";
import {
  experimentHistory,
  findPatterns,
  readDailyReports,
  strategyMatrix,
  tradeHistory,
} from "./read.js";

/** Task 10.6 (design D6): the read models over a real research database. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
const H = hypothesis({ hypothesisId: "H-0001" });

beforeAll(async () => {
  probe = await probeMongo(MONGO_URI, "neelkanth_it_read", "read models");
  if (!probe.reachable) return;
  connection = probe.connection;
  const db = connection.db;
  await db.dropDatabase();
  await ensureIndexes(db);
  await seedCandles(
    db,
    await historicalBars(
      [0, 1, 2, 3, 4, 7, 8, 9, 10, 11],
      (d) => 1 + (d % 5) * 0.04 + d * 0.01,
    ),
  );
  await runDailyResearch(db, {
    symbols: [SYM],
    indexSymbols: [INDEX],
    interval: "5m",
    fromDate: "2026-01-05",
    toDate: "2026-01-16",
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 0,
    regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
    now: Date.UTC(2026, 0, 20),
    recomputeStale: true,
  });
  const test: HypothesisTest = {
    hypothesisId: "H-0001",
    hypothesisFingerprint: hypothesisFingerprint(H),
    family: H.family,
    testedAt: 2,
    gatePolicyVersion: "2",
    outOfSample: {
      dateRange: H.outOfSample,
      n: 100,
      estimate: -40,
      interval: { lower: -60, upper: -20 },
      pValue: 0.01,
      verdict: "SUPPORTED",
      charges: 1,
      slippage: 1,
      net: -4000,
      runFingerprint: "x",
    },
    inSample: {
      dateRange: H.inSample,
      n: 90,
      estimate: -30,
      interval: null,
      pValue: null,
      verdict: "SUPPORTED",
      charges: 1,
      slippage: 1,
      net: -2700,
      runFingerprint: "y",
    },
  };
  const experiments = new StrategyExperimentsRepository(db);
  await experiments.save({
    experimentId: "H-0001",
    kind: "HYPOTHESIS",
    createdAt: 1,
    fingerprint: hypothesisFingerprint(H),
    manifest: H,
    result: {},
  });
  await experiments.save({
    experimentId: "H-0001:test",
    kind: "HYPOTHESIS_TEST",
    createdAt: 2,
    fingerprint: "a".repeat(64),
    manifest: { hypothesisId: "H-0001" },
    result: test as unknown as Record<string, unknown>,
  });
  await indexResearch(db);
}, 300_000);

afterAll(async () => {
  await closeProbe(probe);
});

const skipUnlessMongo = () => probe?.reachable !== true;

describe("read models over the research database (10.6)", () => {
  it("reads the newest daily reports in scope, never past asOf", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const all = await readDailyReports(connection.db, {});
    expect(all.map((r) => r.date)).toHaveLength(10);
    const early = await readDailyReports(connection.db, { asOf: "2026-01-09" });
    expect(early.map((r) => r.date)).toEqual([
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
    ]);
  });

  it("answers with the real reports' versions and cost models", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const reports = await readDailyReports(connection.db, {});
    const trades = tradeHistory(reports, {});
    expect(trades.n).toBe(reports.reduce((n, r) => n + r.trades.length, 0));
    expect(trades.n).toBeGreaterThan(0);
    expect(trades.versions.dailyResearch).toEqual(["1"]);
    expect(trades.versions.strategies.length).toBeGreaterThan(0);
    expect(trades.costs).toHaveLength(1);
    expect(trades.data.sources.length).toBeGreaterThan(0);
    expect(trades.data.ingestionVersions.length).toBeGreaterThan(0);
    const cost = trades.costs[0] as
      | { slippage: { version: string }; transactionCost: { version: string } }
      | undefined;
    expect(typeof cost?.slippage.version).toBe("string");
    expect(typeof cost?.transactionCost.version).toBe("string");
    const patterns = findPatterns(reports, {});
    expect(patterns.n).toBe(reports.reduce((n, r) => n + r.patterns.length, 0));
    const first = patterns.occurrences[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      const m = strategyMatrix(reports, { patternId: first.patternId });
      expect(m.n).toBe(
        patterns.occurrences.filter((o) => o.patternId === first.patternId)
          .length,
      );
      expect(m.excluded.length).toBeGreaterThan(0); // the derivative strategies
    }
  });

  it("experiment history: the hypothesis and its finding, with the gate's version — and nothing before the test's window closed", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const a = await experimentHistory(connection.db, { strategies: ["RSI"] });
    expect(a.entries.map((e) => e.docId).sort()).toEqual([
      "FINDING|H-0001",
      "HYPOTHESIS|H-0001",
    ]);
    expect(a.versions.gatePolicy).toEqual(["2"]);
    expect(a.sources).toBe(2);
    const before = await experimentHistory(connection.db, {
      strategies: ["RSI"],
      asOf: "2026-06-30",
    });
    expect(before).toMatchObject({ n: 0, sources: 0, range: null });
    expect(
      (await experimentHistory(connection.db, { strategies: ["ORB"] })).n,
    ).toBe(0);
  });
});
