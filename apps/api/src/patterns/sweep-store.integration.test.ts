import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PatternObservationSchema, type Candle } from "@neelkanth/core";
import {
  CandlesRepository,
  COLLECTIONS,
  ensureIndexes,
  PatternCatalogRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { createPatternRegistry } from "@neelkanth/patterns";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import {
  CatalogConflictError,
  sweepFromStore,
  type StoredSweepRequest,
} from "./sweep-store.js";

/**
 * Task 5.6 — a sweep over the research dataset, in the research database
 * only (design D6), proved as replay's store was (4.7): by what the code can
 * reach at all, and by running it against real MongoDB beside trading
 * collections that hold data and finding them unchanged.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRADING =
  /\b(Orders|Positions|Trades|Signals|RiskLogs|PnlSnapshots|StrategyState|Settings)Repository\b|COLLECTIONS\.(orders|positions|trades|signals|riskLogs)\b/;

describe("sweep code cannot reach trading state (D6)", () => {
  it("imports no trading repository or collection", () => {
    const files = readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(HERE, f));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => TRADING.test(readFileSync(f, "utf8")))).toEqual(
      [],
    );
  });
});

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

/** Two sessions in which ORB breaks out each day; SUSPECT volume, like the index year. */
const OPEN = [Date.UTC(2026, 0, 5, 3, 45), Date.UTC(2026, 0, 6, 3, 45)];
function bars(symbol: string): Candle[] {
  return OPEN.flatMap((open, day) =>
    Array.from({ length: 20 }, (_, k): Candle => {
      const close = k < 3 ? 100 : k === 3 ? 106 + day : 101 + ((k * 7) % 5);
      return {
        symbol,
        interval: "5m",
        source: "BROKER_HISTORICAL",
        ingestionVersion: 1,
        open: 100,
        high: Math.max(100, close) + (k < 3 ? 5 - k : 0.5),
        low: Math.min(100, close) - (k < 3 ? 5 - k : 0.5),
        close,
        volume: 1_000 + k * 10,
        volumeAvailable: true,
        volumeQuality: "SUSPECT",
        ts: open + k * 300_000,
      };
    }),
  );
}

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
    "neelkanth_it_pattern_sweep",
    "pattern sweep store",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  const candles = new CandlesRepository(connection.db);
  for (const bar of [...bars("NSE:SWEEPA-EQ"), ...bars("NSE:SWEEPB-EQ")])
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
    .collection(COLLECTIONS.patternObservations)
    .deleteMany({});
  await connection.db.collection(COLLECTIONS.patterns).deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

const request = (
  over: Partial<StoredSweepRequest> = {},
): StoredSweepRequest => ({
  symbols: ["NSE:SWEEPA-EQ", "NSE:SWEEPB-EQ"],
  interval: "5m",
  fromDate: "2026-01-05",
  toDate: "2026-01-06",
  observedAt: 5_000,
  save: true,
  ...over,
});
const count = (name: string) => connection.db.collection(name).countDocuments();

describe("a sweep over the stored dataset (§5.6)", () => {
  it("records observations and the catalogue, and leaves trading state alone", async () => {
    const before = await snapshot();
    const report = await sweepFromStore(connection.db, request());

    expect(report.symbols.map((s) => [s.symbol, s.bars, s.sessions])).toEqual([
      ["NSE:SWEEPA-EQ", 40, 2],
      ["NSE:SWEEPB-EQ", 40, 2],
    ]);
    expect(report.symbols[0]?.found["ORB_BREAKOUT"]).toBe(2);
    // SUSPECT volume: the volume-based detectors declined rather than judged.
    expect(report.symbols[0]?.found["HIGH_VOLUME_BREAKOUT"]).toBeUndefined();
    expect(
      report.symbols[0]?.declinedForVolume["VWAP_RECLAIM"],
    ).toBeGreaterThan(0);
    const recorded = report.symbols.reduce((n, s) => n + s.recorded, 0);
    expect(recorded).toBeGreaterThan(0);
    expect(await count(COLLECTIONS.patternObservations)).toBe(recorded);
    expect(report.catalog.added).toHaveLength(5);
    expect(await count(COLLECTIONS.patterns)).toBe(5);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("stores observations that say what they stood on", async () => {
    await sweepFromStore(connection.db, request());
    const kept = await connection.db
      .collection(COLLECTIONS.patternObservations)
      .find({}, { projection: { _id: 0 } })
      .toArray();
    expect(kept.length).toBeGreaterThan(0);
    for (const doc of kept) {
      const o = PatternObservationSchema.parse(doc);
      expect(o.dataProvenance).toMatchObject({
        symbol: o.symbol,
        barTs: o.ts,
        source: "BROKER_HISTORICAL",
        ingestionVersion: 1,
      });
      expect(o.marketContext).toEqual({
        volumeAvailable: true,
        volumeQuality: "SUSPECT",
      });
    }
  }, 60_000);

  it("adds nothing the second time, with the same fingerprint", async () => {
    const first = await sweepFromStore(connection.db, request());
    const second = await sweepFromStore(
      connection.db,
      request({ observedAt: 9_000 }),
    );
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.symbols.every((s) => s.recorded === 0)).toBe(true);
    expect(second.catalog.known).toHaveLength(5);
  }, 60_000);

  it("keeps nothing on a dry run, and agrees with a real one", async () => {
    const dry = await sweepFromStore(connection.db, request({ save: false }));
    expect(await count(COLLECTIONS.patternObservations)).toBe(0);
    expect(await count(COLLECTIONS.patterns)).toBe(0);
    const real = await sweepFromStore(connection.db, request());
    expect(dry.fingerprint).toBe(real.fingerprint);
  }, 60_000);

  /** A rule edited under an old version must not label new evidence. */
  it("refuses the whole sweep when a version's rule has changed", async () => {
    const [orb] = createPatternRegistry()
      .catalog()
      .filter((d) => d.patternId === "ORB_BREAKOUT");
    if (orb === undefined) throw new Error("no ORB");
    await new PatternCatalogRepository(connection.db).register([
      { ...orb, definition: "an older rule" },
    ]);

    await expect(
      sweepFromStore(connection.db, request()),
    ).rejects.toBeInstanceOf(CatalogConflictError);
    await expect(
      sweepFromStore(connection.db, request({ save: false })),
    ).rejects.toThrow(/ORB_BREAKOUT@1\.0\.0/);
    expect(await count(COLLECTIONS.patternObservations)).toBe(0);
  }, 60_000);

  it("runs only the detectors asked for, at the parameters given", async () => {
    const report = await sweepFromStore(
      connection.db,
      request({
        detectors: { ORB_BREAKOUT: { rangeMinutes: 10 } },
        save: false,
      }),
    );
    expect(Object.keys(report.symbols[0]?.skippedForWarmup ?? {})).toEqual([
      "ORB_BREAKOUT",
    ]);
    expect(report.symbols[0]?.occurrences[0]?.params).toMatchObject({
      rangeMinutes: 10,
    });
    expect(report.catalog.added).toEqual(["ORB_BREAKOUT@1.0.0"]);
  }, 60_000);
});
