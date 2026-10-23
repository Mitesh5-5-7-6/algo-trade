import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MongoConnection } from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { seedResearch, SYM } from "../knowledge/test-support.js";
import { ToolContext, toolNamed, type ToolOutcome } from "./tools.js";

/** Task 11.1 (design D1, D2): every tool, against a real research database. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_agent_tools",
    "agent tools",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await seedResearch(connection.db);
}, 300_000);

afterAll(async () => {
  await closeProbe(probe);
});

const skipUnlessMongo = () => probe?.reachable !== true;
const run = async (
  name: string,
  input: unknown,
  asOf = "2026-01-20",
): Promise<Extract<ToolOutcome, { ok: true }>> => {
  const out = await toolNamed(name)?.run(
    input,
    new ToolContext(connection.db, asOf),
  );
  if (out?.ok !== true)
    throw new Error(
      `${name}: ${out === undefined ? "no such tool" : out.error}`,
    );
  return out;
};

describe("the six tools over real research (11.1)", () => {
  it("every evidence tool answers with n, a date range and its versions", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const patterns = await run("find_patterns", {});
    expect(patterns.provenance.n).toBeGreaterThan(0);
    expect(patterns.provenance.range).toEqual({
      fromDate: "2026-01-05",
      toDate: "2026-01-16",
    });
    expect(patterns.provenance.versions["dailyResearch"]).toEqual(["1"]);
    expect(patterns.provenance.data?.ingestionVersions.length).toBeGreaterThan(
      0,
    );

    const trades = await run("trade_history", {});
    expect(trades.provenance.n).toBeGreaterThan(0);
    expect(trades.provenance.costs).toHaveLength(1);
    expect(trades.extra?.["summary"]).toMatchObject({
      wins: expect.any(Number) as number,
    });

    const first = patterns.rows[0] as { patternId: string };
    const matrix = await run("strategy_matrix", { patternId: first.patternId });
    expect(matrix.provenance.n).toBeGreaterThan(0);
    expect((matrix.extra?.["excluded"] as unknown[]).length).toBeGreaterThan(0);

    // The hypothesis's out-of-sample window closes 2026-09-28: unknown before.
    const early = await run("experiment_history", { strategies: ["RSI"] });
    expect(early.provenance).toMatchObject({ n: 0, range: null });
    const experiments = await run(
      "experiment_history",
      { strategies: ["RSI"] },
      "2026-10-01",
    );
    expect(experiments.provenance).toMatchObject({ n: 2 });
    expect(experiments.provenance.versions["gatePolicy"]).toEqual(["2"]);

    const similar = await run("similar_sessions", {
      date: "2026-01-14",
      symbol: SYM,
      k: 3,
    });
    expect(similar.provenance).toMatchObject({ n: 7, asOf: "2026-01-14" });
    expect(similar.rows).toHaveLength(3);
  }, 120_000);

  it("research search is memory, and knows nothing after asOf", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const all = await run("search_research", { kinds: ["DAY"] });
    expect(all).toMatchObject({ evidence: false, total: 10 });
    const early = await run(
      "search_research",
      { kinds: ["DAY"] },
      "2026-01-09",
    );
    expect(early.total).toBe(5);
    expect(early.provenance.range?.toDate).toBe("2026-01-09");
  }, 120_000);

  /** D2: one session reads the reports once, up to its asOf, and never after. */
  it("reads every report up to asOf, and none after it", async (ctx) => {
    if (skipUnlessMongo()) return ctx.skip();
    const session = new ToolContext(connection.db, "2026-01-09");
    const reports = await session.dailyReports();
    expect(reports.map((r) => r.date).at(-1)).toBe("2026-01-09");
    expect(await session.dailyReports()).toBe(reports);
    const trades = await run(
      "trade_history",
      { toDate: "2026-12-31" },
      "2026-01-09",
    );
    expect(trades.provenance.range?.toDate).toBe("2026-01-09");
    expect(trades.notes.join(" ")).toMatch(/clamped to 2026-01-09/);
  }, 120_000);
});
