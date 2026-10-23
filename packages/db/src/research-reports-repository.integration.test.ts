import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import {
  COLLECTIONS,
  ensureIndexes,
  ResearchReportsRepository,
  type MongoConnection,
  type ResearchReportDoc,
} from "./index.js";

/** Phase 8 D5: research_reports — one per (period, date, symbol, version), never edited. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_research_reports",
    "packages/db/src/research-reports-repository.integration.test.ts",
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
  await connection.db.collection(COLLECTIONS.researchReports).deleteMany({});
});
afterAll(async () => {
  await closeProbe(probe);
});

const report = (
  date: string,
  symbol: string,
  version = 1,
  sessions = [date],
): ResearchReportDoc => ({
  reportId: `DAY|${date}|${symbol}|v${String(version)}`,
  period: "DAY",
  date,
  symbol,
  version,
  generatedAt: 1_000 * version,
  fingerprint: String(version).repeat(64).slice(0, 64),
  sessions,
  inputsFingerprint: "a".repeat(64),
  report: { features: { symbol } },
});

describe("ResearchReportsRepository (8.5, D5)", () => {
  it("keeps a report once, and its revision beside it", async () => {
    const repo = new ResearchReportsRepository(connection.db);
    expect(await repo.save(report("2026-03-02", "NSE:A"))).toBe(true);
    expect(await repo.save(report("2026-03-02", "NSE:A"))).toBe(false);
    expect(await repo.save(report("2026-03-02", "NSE:A", 2))).toBe(true);
    expect(
      (await repo.versions("DAY", "2026-03-02", "NSE:A")).map((r) => r.version),
    ).toEqual([1, 2]);
    expect((await repo.latest("DAY", "2026-03-02", "NSE:A"))?.version).toBe(2);
    expect(await repo.latest("DAY", "2026-03-03", "NSE:A")).toBeNull();
  });

  it("lists the newest version of every report in a range", async () => {
    const repo = new ResearchReportsRepository(connection.db);
    await repo.save(report("2026-03-02", "NSE:A"));
    await repo.save(report("2026-03-02", "NSE:A", 2));
    await repo.save(report("2026-03-02", "NSE:B"));
    await repo.save(report("2026-03-03", "NSE:A"));
    await repo.save(report("2026-03-09", "NSE:A"));
    const got = await repo.latestInRange("DAY", "2026-03-02", "2026-03-03");
    expect(got.map((r) => [r.date, r.symbol, r.version])).toEqual([
      ["2026-03-02", "NSE:A", 2],
      ["2026-03-02", "NSE:B", 1],
      ["2026-03-03", "NSE:A", 1],
    ]);
  });

  /** Spec §5.8: which research records depended on this day's bars? */
  it("finds every report that read a session", async () => {
    const repo = new ResearchReportsRepository(connection.db);
    await repo.save(
      report("2026-03-02", "NSE:A", 1, ["2026-02-27", "2026-03-02"]),
    );
    await repo.save(
      report("2026-03-03", "NSE:A", 1, ["2026-03-02", "2026-03-03"]),
    );
    await repo.save(
      report("2026-03-04", "NSE:A", 1, ["2026-03-03", "2026-03-04"]),
    );
    const reading = await repo.latestReading("DAY", "2026-03-02");
    expect(reading.map((r) => r.date)).toEqual(["2026-03-02", "2026-03-03"]);
  });

  /** Phase 9: weeks, months and quarters live beside the days, versioned the same way. */
  it("keeps window reports beside daily ones", async () => {
    const repo = new ResearchReportsRepository(connection.db);
    const week = (version: number): ResearchReportDoc => ({
      ...report("2026-03-02", "ALL", version, ["2026-03-02", "2026-03-04"]),
      reportId: `WEEK|2026-W10|ALL|v${String(version)}`,
      period: "WEEK",
    });
    await repo.save(report("2026-03-02", "NSE:A"));
    await repo.save(week(1));
    await repo.save(week(2));
    expect((await repo.latest("WEEK", "2026-03-02", "ALL"))?.version).toBe(2);
    expect((await repo.latest("DAY", "2026-03-02", "NSE:A"))?.version).toBe(1);
    expect(
      (await repo.latestInRange("WEEK", "2026-03-01", "2026-03-31")).map(
        (r) => r.reportId,
      ),
    ).toEqual(["WEEK|2026-W10|ALL|v2"]);
  });

  it("refuses two documents for one version, and has no TTL", async () => {
    const repo = new ResearchReportsRepository(connection.db);
    await repo.save(report("2026-03-02", "NSE:A"));
    await expect(
      repo.save({ ...report("2026-03-02", "NSE:A"), reportId: "other-id" }),
    ).rejects.toThrow(/duplicate key/);
    const indexes = await connection.db
      .collection(COLLECTIONS.researchReports)
      .indexes();
    expect(indexes.filter((i) => "expireAfterSeconds" in i)).toEqual([]);
  });
});
