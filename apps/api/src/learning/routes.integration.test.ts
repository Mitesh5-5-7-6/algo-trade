import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@neelkanth/logger";
import type { Lesson } from "@neelkanth/core";
import {
  COLLECTIONS,
  SignalContextsRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { buildServer, type ApiServer } from "../server.js";
import { StepUpRequiredError } from "../errors.js";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { registerLessonRoutes } from "./routes.js";

/**
 * PLAN.md 14.28 (operator decision 2026-11-28, option A): the operator — and
 * only the operator, behind step-up — applies a lesson the judge PASSED to
 * paper, can stop it, and sees what it has done since.
 */

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
let app: ApiServer;
const NOW = Date.UTC(2026, 10, 30, 6);
let clock = NOW;

const stats = (n: number, wins: number, pf: number | null) => ({
  n,
  wins,
  winRate: n === 0 ? null : wins / n,
  profitFactor: pf,
  avgNetPct: n === 0 ? null : 0.05,
});
const lesson = (id: string, verdict: Lesson["verdict"]): Lesson => ({
  lessonId: id,
  scope: {
    rule: "MOMENTUM",
    underlying: "BANKNIFTY",
    strategyTypes: ["INDEX_OPTION_MOMENTUM"],
  },
  condition: { kind: "HEAVYWEIGHTS_WITH", minShare: 0.6 },
  summary:
    "Take a trade only when at least 60% of the index's heavyweight stocks move with it",
  learn: {
    from: "2025-09-29",
    to: "2026-06-08",
    all: stats(300, 140, 0.9),
    kept: stats(150, 80, 1.2),
    blocked: stats(150, 60, 0.7),
    unknown: 0,
  },
  test: {
    from: "2026-06-09",
    to: "2026-11-27",
    all: stats(200, 94, 0.89),
    kept: stats(100, 55, 1.25),
    blocked: stats(100, 39, 0.6),
    unknown: 0,
  },
  pValue: 0.001,
  holmThreshold: 0.0014,
  verdict,
  reasons: [],
  judgedAt: NOW - 3_600_000,
  data: {
    sessions: 285,
    from: "2025-09-29",
    to: "2026-11-27",
    costPct: 0.02,
    decayPctPerHour: 0.005,
  },
});
const LESSONS = [lesson("L.PASS", "PASSED"), lesson("L.FAIL", "FAILED")];

/** The research service, faked: its two lesson routes. */
const fakeResearch: typeof fetch = (input) => {
  const path = new URL(input instanceof Request ? input.url : String(input))
    .pathname;
  if (path === "/lessons")
    return Promise.resolve(new Response(JSON.stringify({ lessons: LESSONS })));
  const found = LESSONS.find((l) => path === `/lessons/${l.lessonId}`);
  return Promise.resolve(
    found === undefined
      ? new Response("{}", { status: 404 })
      : new Response(JSON.stringify(found)),
  );
};

const post = (url: string, password?: string) =>
  app.inject({
    method: "POST",
    url,
    payload: password === undefined ? {} : { stepUpPassword: password },
  });

beforeAll(async () => {
  probe = await probeMongo(MONGO_URI, "neelkanth_it_lessons", "lessons");
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  app = buildServer({
    logger: createLogger({
      level: "fatal",
      name: "test",
      destination: { write: () => true },
    }),
    readinessChecks: [],
  });
  registerLessonRoutes(app, {
    db: connection.db,
    verifyStepUp: (_user, password) =>
      password === "pw"
        ? Promise.resolve()
        : Promise.reject(new StepUpRequiredError("password required")),
    research: { url: "http://research.test", token: "t" },
    fetch: fakeResearch,
    now: () => clock,
  });
  await app.ready();
}, 120_000);

beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  await connection.db.collection(COLLECTIONS.appliedLessons).deleteMany({});
  await connection.db.collection(COLLECTIONS.signalContexts).deleteMany({});
  await connection.db.collection(COLLECTIONS.trades).deleteMany({});
});

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- unset when Mongo was unreachable
  await app?.close();
  await closeProbe(probe);
});

describe("lessons in paper (14.28)", () => {
  it("refuses to apply without the step-up password", async () => {
    const res = await post("/lessons/L.PASS/apply");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      await connection.db
        .collection(COLLECTIONS.appliedLessons)
        .countDocuments(),
    ).toBe(0);
  });

  it("refuses a lesson that did not pass its test", async () => {
    const res = await post("/lessons/L.FAIL/apply", "pw");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("FAILED");
  });

  it("applies a passed lesson, shows what it has done, and stops it", async () => {
    clock = NOW;
    expect((await post("/lessons/L.PASS/apply", "pw")).statusCode).toBe(200);
    clock = NOW + 3_600_000; // an hour of trading later

    // After applying: one signal passed and traded (a win), one blocked.
    const contexts = new SignalContextsRepository(connection.db);
    const features = {
      underlying: "BANKNIFTY",
      direction: 1 as const,
      minuteOfDay: 600,
      indexFromOpenWithPct: 0.2,
      indexDayWithPct: 0.4,
      heavyweights: null,
      events: [],
      overnightWithPct: null,
      newsWith: null,
      expiryDay: false,
    };
    for (const [signalId, judgement] of [
      ["sig_a", "pass"],
      ["sig_b", "block"],
    ] as const)
      await contexts.insert({
        signalId,
        strategyId: "str_bn",
        strategyType: "INDEX_OPTION_MOMENTUM",
        symbol: "NSE:BANKNIFTY26DEC51000CE",
        ts: NOW + 60_000,
        features,
        lessons: [{ lessonId: "L.PASS", judgement }],
      });
    await connection.db.collection(COLLECTIONS.trades).insertOne({
      tradeId: "trd_a",
      strategyId: "str_bn",
      entrySignalId: "sig_a",
      entryTime: NOW + 120_000,
      netPnl: 1_250,
    });

    const listed = (await app.inject({ method: "GET", url: "/lessons" })).json<{
      lessons: Lesson[];
      applied: Array<{
        lessonId: string;
        status: string;
        forward: Record<string, number>;
      }>;
    }>();
    expect(listed.lessons.map((l) => l.lessonId)).toEqual(["L.PASS", "L.FAIL"]);
    expect(listed.applied[0]).toMatchObject({
      lessonId: "L.PASS",
      status: "ACTIVE",
      forward: {
        judged: 2,
        blocked: 1,
        passed: 1,
        traded: 1,
        closed: 1,
        wins: 1,
        netPnl: 1_250,
      },
    });

    expect((await post("/lessons/L.PASS/stop", "pw")).statusCode).toBe(200);
    expect((await post("/lessons/L.PASS/stop", "pw")).statusCode).toBe(404);
  });
});
