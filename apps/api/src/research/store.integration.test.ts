import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { istDateKey, istDayStart } from "@neelkanth/core";
import {
  COLLECTIONS,
  ensureIndexes,
  ResearchReportsRepository,
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
import {
  isComplete,
  runDailyResearch,
  type DailyResearchRequest,
} from "./store.js";

/**
 * Task 8.6 (design D6): every completed trading day researched, by one
 * idempotent operation — and a revised bar recomputing exactly the reports
 * that read it, as new versions.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TRADING =
  /\b(Orders|Positions|Trades|Signals|RiskLogs|PnlSnapshots|StrategyState|Settings)Repository\b|COLLECTIONS\.(orders|positions|trades|signals|riskLogs)\b/;

describe("research code cannot reach trading state (D6)", () => {
  it("imports no trading repository or collection", () => {
    const files = readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(HERE, f));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => TRADING.test(readFileSync(f, "utf8")))).toEqual(
      [],
    );
  });
});

describe("a completed day (D6)", () => {
  it("is any earlier date, or today once its session has closed", () => {
    const at = (h: number, m: number) =>
      istDayStart("2026-01-14") + (h * 60 + m) * 60_000;
    expect(isComplete("2026-01-13", at(9, 0), "15:30")).toBe(true);
    expect(isComplete("2026-01-14", at(15, 29), "15:30")).toBe(false);
    expect(isComplete("2026-01-14", at(15, 30), "15:30")).toBe(true);
    expect(isComplete("2026-01-15", at(23, 0), "15:30")).toBe(false);
  });
});

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
// Two weekday weeks from Mon 2026-01-05.
const WEEKDAYS = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
const DATES = [
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-09",
  "2026-01-12",
  "2026-01-13",
  "2026-01-14",
  "2026-01-15",
  "2026-01-16",
];

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_daily_research",
    "daily research store",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
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
    await historicalBars(WEEKDAYS, (d) => 1 + (d % 5) * 0.04 + d * 0.01),
  );
  await connection.db
    .collection(COLLECTIONS.trades)
    .insertOne({ tradeId: "trd_live", status: "CLOSED" });
}, 120_000);

afterAll(async () => {
  await closeProbe(probe);
});

const request = (
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

describe("daily research, run by itself (8.6, D6)", () => {
  it("reports every completed trading day once, and adds nothing the second time", async () => {
    const first = await runDailyResearch(connection.db, request());
    expect(first.reported).toEqual(DATES.map((d) => `${d}|${SYM}|v1`));
    expect(
      await connection.db
        .collection(COLLECTIONS.researchReports)
        .countDocuments(),
    ).toBe(10);

    const second = await runDailyResearch(
      connection.db,
      request({ now: Date.UTC(2026, 0, 21) }),
    );
    expect(second).toEqual({
      reported: [],
      recomputed: [],
      current: 10,
      incomplete: [],
    });
    expect(
      await connection.db.collection(COLLECTIONS.trades).countDocuments(),
    ).toBe(1);
  }, 300_000);

  it("leaves today alone until its session has closed", async () => {
    const midday = istDayStart("2026-01-16") + 12 * 3_600_000;
    const out = await runDailyResearch(connection.db, request({ now: midday }));
    expect(out.incomplete).toEqual(["2026-01-16"]);
    expect(out.reported).not.toContain(`2026-01-16|${SYM}|v1`);
  }, 300_000);

  /**
   * Spec §5.8, end to end: revise one bar, and exactly the reports whose
   * sessions include its day are recomputed — that day and the next four —
   * as version 2, with version 1 kept beside it.
   */
  it("recomputes exactly the reports a revised bar reaches, as new versions", async () => {
    await runDailyResearch(connection.db, request());
    const revised = Date.UTC(2026, 0, 8, 3, 45) + 20 * 300_000;
    const changed = await connection.db
      .collection(COLLECTIONS.candles)
      .updateOne(
        { symbol: SYM, interval: "5m", ts: revised },
        { $set: { close: 1234.5 } },
      );
    expect(changed.modifiedCount).toBe(1);
    expect(istDateKey(revised)).toBe("2026-01-08");

    const out = await runDailyResearch(
      connection.db,
      request({ now: Date.UTC(2026, 0, 22) }),
    );
    expect(out.recomputed).toEqual(
      [
        "2026-01-08",
        "2026-01-09",
        "2026-01-12",
        "2026-01-13",
        "2026-01-14",
      ].map((d) => `${d}|${SYM}|v2`),
    );
    expect(out.reported).toEqual([]);
    expect(out.current).toBe(5);

    const repo = new ResearchReportsRepository(connection.db);
    expect(
      (await repo.versions("DAY", "2026-01-08", SYM)).map((r) => r.version),
    ).toEqual([1, 2]);
    expect(
      (await repo.versions("DAY", "2026-01-15", SYM)).map((r) => r.version),
    ).toEqual([1]);
    // And the revision is settled: a further run recomputes nothing.
    expect(
      (
        await runDailyResearch(
          connection.db,
          request({ now: Date.UTC(2026, 0, 23) }),
        )
      ).recomputed,
    ).toEqual([]);
  }, 300_000);

  it("leaves a stale report as it is unless asked to recompute", async () => {
    await runDailyResearch(connection.db, request());
    await connection.db
      .collection(COLLECTIONS.candles)
      .updateOne(
        { symbol: SYM, interval: "5m", ts: Date.UTC(2026, 0, 8, 3, 45) },
        { $set: { close: 1 } },
      );
    expect(
      (
        await runDailyResearch(
          connection.db,
          request({ recomputeStale: false }),
        )
      ).recomputed,
    ).toEqual([]);
  }, 300_000);
});
