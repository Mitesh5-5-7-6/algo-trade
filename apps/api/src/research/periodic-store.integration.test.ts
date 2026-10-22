import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { runDailyResearch, type DailyResearchRequest } from "./store.js";
import {
  runPeriodicResearch,
  type PeriodicResearchRequest,
} from "./periodic-store.js";
import type { WindowReport } from "./window-report.js";

/**
 * Task 9.5 (design D6): every complete window researched by one idempotent
 * operation — and a revised bar reaching its day, then exactly its windows.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
// Two weekday weeks from Mon 2026-01-05.
const WEEKDAYS = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_periodic_research",
    "periodic research store",
  );
  if (probe.reachable) connection = probe.connection;
}, 120_000);

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
const periodic = (
  over: Partial<PeriodicResearchRequest> = {},
): PeriodicResearchRequest => ({
  periods: ["WEEK", "MONTH", "QUARTER"],
  symbols: [SYM],
  fromDate: "2026-01-05",
  toDate: "2026-01-16",
  calendar: { holidays: [], specialSessions: [], source: "test" },
  close: "15:30",
  now: Date.UTC(2026, 0, 20),
  recomputeStale: true,
  ...over,
});

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
  await runDailyResearch(connection.db, daily());
}, 300_000);

afterAll(async () => {
  await closeProbe(probe);
});

describe("periodic research, run by itself (9.5, D6)", () => {
  it("reports every complete window once, leaves incomplete ones, and adds nothing the second time", async () => {
    const first = await runPeriodicResearch(connection.db, periodic());
    expect(first.reported).toEqual(["2026-W02|v1", "2026-W03|v1"]);
    expect(first.incomplete).toEqual(["2026-01", "2026-Q1"]); // their last trading days are still to come
    const again = await runPeriodicResearch(
      connection.db,
      periodic({ now: Date.UTC(2026, 0, 21) }),
    );
    expect(again).toEqual({
      reported: [],
      recomputed: [],
      current: 2,
      incomplete: ["2026-01", "2026-Q1"],
    });
  }, 300_000);

  /** Complete but with half its days unreported: built anyway, with the gaps named. */
  it("reports a complete window with gaps as it is, gaps named", async () => {
    const out = await runPeriodicResearch(
      connection.db,
      periodic({ periods: ["MONTH"], now: Date.UTC(2026, 1, 3) }),
    );
    expect(out.reported).toEqual(["2026-01|v1"]);
    const month = await new ResearchReportsRepository(connection.db).latest(
      "MONTH",
      "2026-01-01",
      "ALL",
    );
    const coverage = (month?.report as unknown as WindowReport).coverage[SYM];
    expect(coverage?.reported).toBe(10);
    expect(coverage?.gaps[0]).toBe("2026-01-01");
    expect(coverage?.gaps).toContain("2026-01-30");
  }, 300_000);

  /**
   * A revised bar on 2026-01-08 reaches that day and the four sessions after
   * it (Phase 8) — all in week 2 except 01-12 .. 01-14, in week 3 — so both
   * weeks are recomputed, as version 2, and nothing else.
   */
  it("recomputes exactly the windows whose daily reports were revised", async () => {
    await runPeriodicResearch(connection.db, periodic());
    await connection.db.collection(COLLECTIONS.candles).updateOne(
      {
        symbol: SYM,
        interval: "5m",
        ts: Date.UTC(2026, 0, 8, 3, 45) + 20 * 300_000,
      },
      { $set: { close: 1234.5 } },
    );
    const days = await runDailyResearch(
      connection.db,
      daily({ now: Date.UTC(2026, 0, 22) }),
    );
    expect(days.recomputed).toHaveLength(5);
    const out = await runPeriodicResearch(
      connection.db,
      periodic({ now: Date.UTC(2026, 0, 22) }),
    );
    expect(out.recomputed).toEqual(["2026-W02|v2", "2026-W03|v2"]);
    expect(
      (
        await runPeriodicResearch(
          connection.db,
          periodic({ now: Date.UTC(2026, 0, 23) }),
        )
      ).recomputed,
    ).toEqual([]);
    const repo = new ResearchReportsRepository(connection.db);
    expect(
      (await repo.versions("WEEK", "2026-01-05", "ALL")).map((r) => r.version),
    ).toEqual([1, 2]);
  }, 300_000);

  /** Every collection's documents, before and after: only research_reports may change. */
  it("writes research reports and nothing else", async () => {
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const c of await connection.db.listCollections().toArray())
        out[c.name] = await connection.db.collection(c.name).countDocuments();
      return out;
    };
    const before = await counts();
    await runPeriodicResearch(connection.db, periodic());
    const after = await counts();
    const changed = Object.keys(after).filter(
      (name) => after[name] !== before[name],
    );
    expect(changed).toEqual([COLLECTIONS.researchReports]);
  }, 300_000);
});
