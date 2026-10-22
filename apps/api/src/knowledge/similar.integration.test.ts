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
import { runDailyResearch } from "../research/store.js";
import { findSimilarSessions } from "./similar.js";

/** Task 10.5 (design D4, D5): similar sessions over the stored daily reports, never past asOf. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_similar",
    "similar sessions",
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
  await runDailyResearch(connection.db, {
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
}, 300_000);

afterAll(async () => {
  await closeProbe(probe);
});

describe("similar sessions from the daily reports (10.5)", () => {
  it("compares a day with every earlier day, nearest first", async () => {
    const a = await findSimilarSessions(connection.db, {
      date: "2026-01-14",
      symbol: SYM,
      k: 3,
    });
    expect(a).not.toBeNull();
    expect(a?.poolSize).toBe(7); // 01-05 … 01-13, ten sessions less the weekend
    expect(a?.range).toEqual({ fromDate: "2026-01-05", toDate: "2026-01-13" });
    expect(a?.nearest).toHaveLength(3);
    expect(a?.nearest.every((s) => s.date < "2026-01-14")).toBe(true);
    const d = a?.nearest.map((s) => s.distance) ?? [];
    expect([...d].sort((x, y) => x - y)).toEqual(d);
  }, 120_000);

  /** D5: the answer for a day is the same before and after later days are researched. */
  it("is unchanged by later sessions", async () => {
    const q = { date: "2026-01-08", symbol: SYM, k: 10 };
    const all = await findSimilarSessions(connection.db, q);
    expect(all?.poolSize).toBe(3);
    await connection.db
      .collection(COLLECTIONS.researchReports)
      .deleteMany({ period: "DAY", date: { $gt: "2026-01-08" } });
    expect(await findSimilarSessions(connection.db, q)).toEqual(all);
  }, 120_000);

  it("answers nothing for a day with no report", async () => {
    expect(
      await findSimilarSessions(connection.db, {
        date: "2026-01-10",
        symbol: SYM,
      }),
    ).toBeNull();
  }, 120_000);
});
