import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PatternOccurrence } from "@neelkanth/core";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import {
  COLLECTIONS,
  ensureIndexes,
  PatternObservationsRepository,
  type MongoConnection,
} from "./index.js";

/**
 * `PatternObservationsRepository` against REAL MongoDB (plan/27 §2).
 *
 * The behaviour worth testing here is not "does it store a document" — it is
 * the identity rule. A sweep that double-counts inflates every statistic
 * downstream, and a sweep that collapses two detector versions destroys the
 * evidence earlier findings rest on. Both failures are invisible in the data
 * they produce, which is why they are asserted against a real unique index
 * rather than a mock.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";

let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_patterns",
    "packages/db/src/pattern-observations-repository.integration.test.ts",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
});

beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  await connection.db
    .collection(COLLECTIONS.patternObservations)
    .deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

const SWEEP_AT = 1_760_100_000_000;
const BAR = 1_760_000_900_000;

/** Provenance follows the fixture's own bar, so an override moves both. */
const occurrence = (
  overrides: Partial<PatternOccurrence> = {},
): PatternOccurrence => {
  const base = {
    patternId: "ORB_BREAKOUT",
    detectorVersion: "1.0.0",
    symbol: "NSE:NIFTY50-INDEX",
    interval: "5m",
    ts: BAR,
    direction: "BULLISH" as const,
    evidence: { rangeHigh: 105, rangeLow: 95, close: 106 },
    params: { rangeMinutes: 15 },
    marketContext: { volumeAvailable: true, volumeQuality: "SUSPECT" as const },
    ...overrides,
  };
  return {
    ...base,
    dataProvenance: overrides.dataProvenance ?? {
      symbol: base.symbol,
      interval: base.interval as "5m",
      barTs: base.ts,
      source: "BROKER_HISTORICAL",
      ingestionVersion: 1,
    },
  };
};

describe("PatternObservationsRepository", () => {
  it("records a detection and reads it back by symbol and date", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    expect(await repo.record(occurrence(), SWEEP_AT)).toBe(true);

    const found = await repo.findRange(BAR, BAR + 1, {
      symbol: "NSE:NIFTY50-INDEX",
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.patternId).toBe("ORB_BREAKOUT");
    expect(found[0]?.evidence["rangeHigh"]).toBe(105);
    expect(found[0]?.paramsKey).toBe('{"rangeMinutes":15}');
    // D4: what the observation stood on survives the round trip.
    expect(found[0]?.dataProvenance).toEqual({
      symbol: "NSE:NIFTY50-INDEX",
      interval: "5m",
      barTs: BAR,
      source: "BROKER_HISTORICAL",
      ingestionVersion: 1,
    });
    expect(found[0]?.marketContext).toEqual({
      volumeAvailable: true,
      volumeQuality: "SUSPECT",
    });
  });

  /**
   * The failure this prevents: a nightly sweep re-run over the same week
   * silently doubles every sample. Sample size is the denominator of every
   * statistic, so a double-count turns noise into a finding.
   */
  it("does not count the same detection twice when a sweep re-runs", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    const detection = occurrence({ symbol: "NSE:RERUN-EQ" });

    expect(await repo.record(detection, SWEEP_AT)).toBe(true);
    expect(await repo.record(detection, SWEEP_AT + 86_400_000)).toBe(false);

    const found = await repo.findRange(BAR, BAR + 1, {
      symbol: "NSE:RERUN-EQ",
    });
    expect(found).toHaveLength(1);
    // The first sweep's stamp survives — a re-run records nothing, including
    // not rewriting when it thinks it first saw this.
    expect(found[0]?.observedAt).toBe(SWEEP_AT);
  });

  /**
   * Two definitions of one bar are two rows. This is the opposite of the
   * candle precedence rule, deliberately: there is one truth about what the
   * market did, and no single truth about whether it was a breakout.
   */
  it("keeps a redefined detector's output beside the original", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    const symbol = "NSE:VERSIONED-EQ";
    await repo.record(occurrence({ symbol }), SWEEP_AT);
    await repo.record(
      occurrence({ symbol, detectorVersion: "2.0.0", direction: "BEARISH" }),
      SWEEP_AT,
    );

    const found = await repo.findRange(BAR, BAR + 1, { symbol });
    expect(found).toHaveLength(2);
    expect(found.map((row) => row.detectorVersion).sort()).toEqual([
      "1.0.0",
      "2.0.0",
    ]);

    // And research can still ask for exactly one definition.
    const v1 = await repo.findRange(BAR, BAR + 1, {
      symbol,
      detectorVersion: "1.0.0",
    });
    expect(v1).toHaveLength(1);
    expect(v1[0]?.direction).toBe("BULLISH");
  });

  /**
   * A parameter sweep is the point of Phase 12. Without `paramsKey` in the
   * identity, five settings would store one row and discard four — and the
   * comparison the sweep exists to make would be unavailable.
   */
  it("stores one row per parameter set at the same version", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    const symbol = "NSE:SWEPT-EQ";
    await repo.record(occurrence({ symbol, params: { rangeMinutes: 15 } }), 1);
    await repo.record(occurrence({ symbol, params: { rangeMinutes: 30 } }), 1);
    await repo.record(occurrence({ symbol, params: { rangeMinutes: 45 } }), 1);

    const found = await repo.findRange(BAR, BAR + 1, { symbol });
    expect(found).toHaveLength(3);
  });

  it("writes a batch and reports only the rows that were new", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    const symbol = "NSE:BATCH-EQ";
    const batch = [
      occurrence({ symbol, ts: BAR }),
      occurrence({ symbol, ts: BAR + 300_000 }),
      occurrence({ symbol, ts: BAR + 600_000 }),
    ];

    expect(await repo.recordMany(batch, SWEEP_AT)).toBe(3);
    // Re-running the sweep with one extra bar adds exactly one row.
    expect(
      await repo.recordMany(
        [...batch, occurrence({ symbol, ts: BAR + 900_000 })],
        SWEEP_AT,
      ),
    ).toBe(1);

    const found = await repo.findRange(BAR, BAR + 1_200_000, { symbol });
    expect(found).toHaveLength(4);
    // Oldest first, so a caller can walk a day in order.
    expect(found.map((row) => row.ts)).toEqual([
      BAR,
      BAR + 300_000,
      BAR + 600_000,
      BAR + 900_000,
    ]);
  });

  it("writes nothing for an empty batch", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    expect(await repo.recordMany([], SWEEP_AT)).toBe(0);
  });

  it("reads a half-open range, so consecutive days tile exactly", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    const symbol = "NSE:TILED-EQ";
    await repo.recordMany(
      [
        occurrence({ symbol, ts: 2_000_000 }),
        occurrence({ symbol, ts: 3_000_000 }),
      ],
      SWEEP_AT,
    );

    const first = await repo.findRange(2_000_000, 3_000_000, { symbol });
    const second = await repo.findRange(3_000_000, 4_000_000, { symbol });
    expect(first.map((r) => r.ts)).toEqual([2_000_000]);
    expect(second.map((r) => r.ts)).toEqual([3_000_000]);
  });

  it("returns nothing for an inverted range", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    expect(await repo.findRange(BAR + 1, BAR)).toEqual([]);
    expect(await repo.versionsInRange(BAR + 1, BAR)).toEqual([]);
    expect(await repo.deleteRange(BAR + 1, BAR)).toBe(0);
  });

  /**
   * §5.1 requires research to be able to ask "under which definition?" before
   * pooling anything. A rule nobody can check cheaply is a rule that erodes.
   */
  it("reports which definitions produced the evidence in a window", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    const symbol = "NSE:AUDIT-EQ";
    await repo.recordMany(
      [
        occurrence({ symbol, ts: BAR }),
        occurrence({ symbol, ts: BAR + 300_000 }),
        occurrence({ symbol, ts: BAR, detectorVersion: "2.0.0" }),
      ],
      SWEEP_AT,
    );

    const versions = await repo.versionsInRange(BAR, BAR + 600_000, { symbol });
    expect(versions).toEqual([
      {
        patternId: "ORB_BREAKOUT",
        detectorVersion: "1.0.0",
        paramsKey: '{"rangeMinutes":15}',
        count: 2,
      },
      {
        patternId: "ORB_BREAKOUT",
        detectorVersion: "2.0.0",
        paramsKey: '{"rangeMinutes":15}',
        count: 1,
      },
    ]);
  });

  /**
   * The data revision policy (§5.8): a revised candle makes everything derived
   * from it stale. Because `record` refuses to overwrite, deletion is the only
   * way to recompute — so it must exist, and must be scoped narrowly enough to
   * use without destroying neighbouring evidence.
   */
  it("clears a window so a revised candle can be recomputed", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    const symbol = "NSE:REVISED-EQ";
    await repo.recordMany(
      [
        occurrence({ symbol, ts: BAR, evidence: { close: 106 } }),
        occurrence({ symbol, ts: BAR + 300_000 }),
      ],
      SWEEP_AT,
    );

    expect(await repo.deleteRange(BAR, BAR + 1, { symbol })).toBe(1);
    // The neighbouring bar is untouched.
    expect(await repo.findRange(BAR, BAR + 600_000, { symbol })).toHaveLength(
      1,
    );

    // The recomputed detection now stores, where before it was refused.
    expect(
      await repo.record(
        occurrence({ symbol, ts: BAR, evidence: { close: 109 } }),
        SWEEP_AT + 1,
      ),
    ).toBe(true);
    const found = await repo.findRange(BAR, BAR + 1, { symbol });
    expect(found[0]?.evidence["close"]).toBe(109);
  });

  it("narrows by pattern and direction across symbols", async () => {
    const repo = new PatternObservationsRepository(connection.db);
    await repo.recordMany(
      [
        occurrence({ symbol: "NSE:A-EQ", ts: 9_000_000 }),
        occurrence({
          symbol: "NSE:B-EQ",
          ts: 9_000_000,
          direction: "BEARISH",
        }),
        occurrence({
          symbol: "NSE:C-EQ",
          ts: 9_000_000,
          patternId: "EMA_CROSS",
        }),
      ],
      SWEEP_AT,
    );

    const orb = await repo.findRange(9_000_000, 9_000_001, {
      patternId: "ORB_BREAKOUT",
    });
    expect(orb.map((r) => r.symbol).sort()).toEqual(["NSE:A-EQ", "NSE:B-EQ"]);

    const bullish = await repo.findRange(9_000_000, 9_000_001, {
      patternId: "ORB_BREAKOUT",
      direction: "BULLISH",
    });
    expect(bullish.map((r) => r.symbol)).toEqual(["NSE:A-EQ"]);
  });
});
