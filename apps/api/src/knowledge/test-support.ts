import type { Db } from "mongodb";
import { ensureIndexes, StrategyExperimentsRepository } from "@neelkanth/db";
import { seedCandles } from "../test-support/candles.js";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import { runDailyResearch } from "../research/store.js";
import type { HypothesisTest } from "../validation/gate.js";
import { hypothesisFingerprint } from "../validation/hypothesis.js";
import { hypothesis } from "../validation/test-support.js";
import { indexResearch } from "./indexer.js";

export const SYM = "NSE:TESTCO-EQ";
export const INDEX = "NSE:TESTINDEX-INDEX";
const H = hypothesis({ hypothesisId: "H-0001" });

/**
 * A small research database, as the pipeline leaves it: two weeks of daily
 * reports (2026-01-05 .. 2026-01-16, one instrument), one hypothesis tested
 * SUPPORTED at n = 100, and the index built. For integration suites only.
 */
export async function seedResearch(db: Db): Promise<void> {
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
}
