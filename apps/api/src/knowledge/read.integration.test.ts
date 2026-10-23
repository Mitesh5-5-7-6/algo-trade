import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MongoConnection } from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import {
  experimentHistory,
  findPatterns,
  readDailyReports,
  strategyMatrix,
  tradeHistory,
} from "./read.js";
import { seedResearch } from "./test-support.js";

/** Task 10.6 (design D6): the read models over a real research database. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(MONGO_URI, "neelkanth_it_read", "read models");
  if (!probe.reachable) return;
  connection = probe.connection;
  await seedResearch(connection.db);
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
