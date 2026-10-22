import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  DocumentsRepository,
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
import { seedCandles } from "../test-support/candles.js";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import {
  runDailyResearch,
  type DailyResearchRequest,
} from "../research/store.js";
import { runPeriodicResearch } from "../research/periodic-store.js";
import { indexResearch } from "./indexer.js";

/**
 * Task 10.3 (design D3, D7): the research database indexed into documents —
 * idempotently, a revision re-indexing exactly what it changed — and
 * nothing else written.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRADING =
  /\b(Orders|Positions|Trades|Signals|RiskLogs|PnlSnapshots|StrategyState|Settings)Repository\b|COLLECTIONS\.(orders|positions|trades|signals|riskLogs)\b/;

describe("knowledge code cannot reach trading state (D7)", () => {
  it("imports no trading repository or collection", () => {
    const files = readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(HERE, f));
    expect(files.length).toBeGreaterThan(2);
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
const daily = (
  over: Partial<DailyResearchRequest> = {},
): DailyResearchRequest => ({
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
  ...over,
});

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_knowledge",
    "knowledge indexer",
  );
  if (probe.reachable) connection = probe.connection;
}, 120_000);

beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  await seedCandles(
    connection.db,
    await historicalBars(
      [0, 1, 2, 3, 4, 7, 8, 9, 10, 11],
      (d) => 1 + (d % 5) * 0.04 + d * 0.01,
    ),
  );
  await runDailyResearch(connection.db, daily());
  await runPeriodicResearch(connection.db, {
    periods: ["WEEK"],
    symbols: [SYM],
    fromDate: "2026-01-05",
    toDate: "2026-01-16",
    calendar: { holidays: [], specialSessions: [], source: "test" },
    close: "15:30",
    now: Date.UTC(2026, 0, 20),
    recomputeStale: true,
  });
  await new PatternCatalogRepository(connection.db).register(
    createPatternRegistry().catalog(),
  );
}, 300_000);

afterAll(async () => {
  await closeProbe(probe);
});

describe("indexing the research database (10.3, D3)", () => {
  it("renders every source into documents, once each, and a second run changes nothing", async () => {
    const first = await indexResearch(connection.db);
    expect(first.byKind).toMatchObject({ DAY: 10, WINDOW: 2, DETECTOR: 5 });
    expect(first.byKind["TRADE"]).toBeGreaterThan(0);
    expect(first.byKind["CHART"]).toBe(10 + (first.byKind["TRADE"] ?? 0));
    const total = Object.values(first.byKind).reduce((n, v) => n + v, 0);
    expect(first).toMatchObject({
      added: total,
      replaced: 0,
      unchanged: 0,
      removed: 0,
    });
    expect(
      await connection.db.collection(COLLECTIONS.documents).countDocuments(),
    ).toBe(total);

    const second = await indexResearch(connection.db);
    expect(second).toMatchObject({
      added: 0,
      replaced: 0,
      unchanged: total,
      removed: 0,
    });
  }, 300_000);

  /**
   * One revised bar on 2026-01-08 recomputes five daily reports and two
   * weeks (Phases 8, 9); re-indexing replaces exactly their documents and
   * removes any Trade that no longer exists.
   */
  it("re-indexes exactly the documents a revision reaches", async () => {
    await indexResearch(connection.db);
    const before = new Map(
      (
        await connection.db
          .collection(COLLECTIONS.documents)
          .find({}, { projection: { _id: 0, docId: 1, contentFingerprint: 1 } })
          .toArray()
      ).map((d) => [String(d["docId"]), String(d["contentFingerprint"])]),
    );
    await connection.db.collection(COLLECTIONS.candles).updateOne(
      {
        symbol: SYM,
        interval: "5m",
        ts: Date.UTC(2026, 0, 8, 3, 45) + 20 * 300_000,
      },
      { $set: { close: 1234.5 } },
    );
    await runDailyResearch(
      connection.db,
      daily({ now: Date.UTC(2026, 0, 22) }),
    );
    await runPeriodicResearch(connection.db, {
      periods: ["WEEK"],
      symbols: [SYM],
      fromDate: "2026-01-05",
      toDate: "2026-01-16",
      calendar: { holidays: [], specialSessions: [], source: "test" },
      close: "15:30",
      now: Date.UTC(2026, 0, 22),
      recomputeStale: true,
    });

    const out = await indexResearch(connection.db);
    const after = await connection.db
      .collection(COLLECTIONS.documents)
      .find(
        {},
        {
          projection: {
            _id: 0,
            docId: 1,
            contentFingerprint: 1,
            "source.version": 1,
            subject: 1,
          },
        },
      )
      .toArray();
    const moved = after.filter(
      (d) => before.get(String(d["docId"])) !== String(d["contentFingerprint"]),
    );
    const touchedDays = new Set(
      moved.map((d) => (d["subject"] as { fromDate: string }).fromDate),
    );
    // Only the five recomputed days, and the two weeks that read them.
    for (const day of touchedDays)
      expect([
        "2026-01-08",
        "2026-01-09",
        "2026-01-12",
        "2026-01-13",
        "2026-01-14",
        "2026-01-05",
      ]).toContain(day);
    expect(
      moved.some((d) => String(d["docId"]) === "WINDOW|WEEK|2026-W02"),
    ).toBe(true);
    expect(
      moved.some((d) => String(d["docId"]) === "WINDOW|WEEK|2026-W03"),
    ).toBe(true);
    expect(
      moved.every((d) => !String(d["docId"]).startsWith("DAY|2026-01-15")),
    ).toBe(true);
    expect(out.added + out.replaced).toBe(moved.length);
    expect(out.unchanged + out.replaced + out.added).toBe(after.length);
    expect(
      (
        await new DocumentsRepository(connection.db).findById(
          `DAY|2026-01-08|${SYM}`,
        )
      )?.source.version,
    ).toBe(2);
  }, 300_000);

  it("writes documents and nothing else", async () => {
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const c of await connection.db.listCollections().toArray())
        out[c.name] = await connection.db.collection(c.name).countDocuments();
      return out;
    };
    const before = await counts();
    await indexResearch(connection.db);
    const after = await counts();
    expect(
      Object.keys(after).filter((name) => after[name] !== before[name]),
    ).toEqual([COLLECTIONS.documents]);
  }, 300_000);
});
