import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { istDateKey } from "@neelkanth/core";
import {
  COLLECTIONS,
  ensureIndexes,
  PaperReconciliationsRepository,
  PaperSessionReportsRepository,
  RiskLogsRepository,
  SettingsRepository,
  SignalsRepository,
  StrategiesRepository,
  TradesRepository,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { seedCandles } from "../test-support/candles.js";
import { runHistoricalReplay } from "../replay/run.js";
import {
  emaStrategy,
  goldenBudget,
  historicalBars,
} from "../replay/test-support.js";
import { reportSessionFromStore } from "./session-report-store.js";

/**
 * Task 14.5 (design D6): a paper session reported from the paper database and
 * held against the replay of the bars it built. The "paper" rows here are a
 * replay's own decisions written where the live runtime writes them, so the
 * report must find them in agreement — and must name what is taken away.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
const HOURS = { open: "09:15", close: "15:30", squareOff: "15:12" };
const SESSION = "2026-01-09"; // the last of five days; the rest are warm-up
const DAYS = [0, 1, 2, 3, 4];
const scale = (d: number) => 1 + (d % 5) * 0.04 + d * 0.01;

let probe: MongoProbe | undefined;
let connection: MongoConnection;

/** What the paper runtime would have written for the session. */
async function writePaperSession(
  drop: { trades?: number } = {},
): Promise<number> {
  const db = connection.db;
  const { trail } = await runHistoricalReplay({
    strategy: emaStrategy(),
    candles: await historicalBars(DAYS, scale),
    hours: HOURS,
    ...goldenBudget(),
    seed: 0,
  });
  const today = <T extends { ts?: number; entryTime?: number }>(rows: T[]) =>
    rows.filter((r) => istDateKey(r.ts ?? r.entryTime ?? 0) === SESSION);
  const signals = new SignalsRepository(db);
  for (const s of today(trail.signals)) await signals.insert(s);
  const riskLogs = new RiskLogsRepository(db);
  for (const l of today(trail.riskLogs)) await riskLogs.insert(l);
  const trades = new TradesRepository(db);
  const kept = today(trail.trades).slice(drop.trades ?? 0);
  for (const t of kept) await trades.save(t);
  await new PaperReconciliationsRepository(db).insert({
    runId: "recon_close",
    session: SESSION,
    at: "CLOSE",
    ts: Date.UTC(2026, 0, 9, 10, 1),
    clean: true,
    mismatches: 0,
  });
  return today(trail.trades).length;
}

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_paper_session_reports",
    "paper session reports",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
}, 120_000);

beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  const db = connection.db;
  await db.dropDatabase();
  await ensureIndexes(db);
  await seedCandles(db, await historicalBars(DAYS, scale));
  const { allocatedCapital, limits } = goldenBudget();
  const strategy = emaStrategy();
  await new SettingsRepository(db).updateGlobal({
    marketHours: HOURS,
    capitalAllocation: allocatedCapital,
    globalRiskLimits: limits,
    indexSymbols: ["NSE:TESTINDEX-INDEX"],
    breadthSymbols: strategy.symbols,
  });
  await new StrategiesRepository(db).create({
    ...strategy,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });
}, 120_000);

afterAll(async () => {
  await closeProbe(probe);
});

describe("a paper session, reported and held against its replay (14.5)", () => {
  it("finds a session that decided as its replay did clean, throughout", async () => {
    const traded = await writePaperSession();
    expect(traded).toBeGreaterThan(0); // hollow otherwise

    const { report, saved } = await reportSessionFromStore(
      connection.db,
      { session: SESSION, generatedAt: 1 },
      { save: false },
    );

    expect(saved).toBe(false);
    expect(report.parity.differences).toEqual([]);
    expect(report.parity.compared.paperTrades).toBe(traded);
    expect(report.record.reconciliation.clean).toBe(true);
    expect(report.record.trades).toHaveLength(traded);
    expect(report.replay).toMatchObject({
      interval: "5m",
      excluded: [],
      strategies: [
        expect.objectContaining({ strategyId: emaStrategy().strategyId }),
      ],
    });
    expect(report.clean).toBe(true);
    expect(
      await new PaperSessionReportsRepository(connection.db).forSession(
        SESSION,
      ),
    ).toEqual([]);
  });

  it("names a Trade the session lacks, and keeps the report once", async () => {
    await writePaperSession({ trades: 1 });
    const before = (await connection.db.listCollections().toArray())
      .map((c) => c.name)
      .sort();

    const keep = { save: true as const, reportId: "psr_1" };
    const { report, saved } = await reportSessionFromStore(
      connection.db,
      { session: SESSION, generatedAt: 2 },
      keep,
    );

    expect(report.clean).toBe(false);
    expect(report.parity.differences).toContainEqual(
      expect.objectContaining({
        kind: "TRADE",
        field: "presence",
        paper: "absent",
      }),
    );
    expect(saved).toBe(true);
    const again = await reportSessionFromStore(
      connection.db,
      { session: SESSION, generatedAt: 3 },
      keep,
    );
    expect(again.saved).toBe(false); // an id is never overwritten

    const reports = new PaperSessionReportsRepository(connection.db);
    expect(await reports.forSession(SESSION)).toEqual([
      expect.objectContaining({ reportId: "psr_1", clean: false }),
    ]);
    expect(await reports.latestPerSession(5)).toHaveLength(1);
    // Only the report is written.
    const after = (await connection.db.listCollections().toArray())
      .map((c) => c.name)
      .sort();
    expect(after).toEqual(
      [...new Set([...before, COLLECTIONS.paperSessionReports])].sort(),
    );
  });

  it("is not clean when the session was never reconciled at the bell", async () => {
    await writePaperSession();
    await connection.db
      .collection(COLLECTIONS.paperReconciliations)
      .deleteMany({});

    const { report } = await reportSessionFromStore(
      connection.db,
      { session: SESSION, generatedAt: 4 },
      { save: false },
    );

    expect(report.parity.clean).toBe(true);
    expect(report.record.reconciliation.missing).toEqual(["CLOSE"]);
    expect(report.clean).toBe(false);
  });
});
