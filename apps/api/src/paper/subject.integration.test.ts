import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  ensureIndexes,
  StrategiesRepository,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { provisionSubject, SUBJECT_SYMBOLS } from "./subject.js";

/**
 * Task 14.6 (design D1): the test subject, provisioned into the paper
 * database — enabled, marked `subject`, no candidate — and never changed by
 * provisioning it again.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_paper_subject",
    "paper subject",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
}, 120_000);

beforeEach(async (ctx) => {
  if (probe?.reachable !== true) {
    ctx.skip();
    return;
  }
  await connection.db.collection(COLLECTIONS.strategies).deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

describe("the Phase 14 test subject (14.6)", () => {
  it("provisions ORB and EMA_CROSSOVER on both indices, enabled, as a subject", async () => {
    const { created, existing } = await provisionSubject(connection.db, {
      now: 1,
    });

    expect(existing).toEqual([]);
    expect(created.map((c) => c.type)).toEqual(["ORB", "EMA_CROSSOVER"]);
    const enabled = await new StrategiesRepository(connection.db).findEnabled();
    expect(enabled).toHaveLength(2);
    for (const c of enabled) {
      expect(c).toMatchObject({
        symbols: SUBJECT_SYMBOLS,
        params: {},
        validation: { role: "subject" },
      });
    }
  });

  it("leaves a provisioned subject exactly as it is when provisioned again", async () => {
    await provisionSubject(connection.db, { now: 1 });
    const repo = new StrategiesRepository(connection.db);
    await repo.setEnabled("subject_orb", false);

    const again = await provisionSubject(connection.db, { now: 2 });

    expect(again.created).toEqual([]);
    expect(again.existing.map((c) => c.strategyId)).toEqual([
      "subject_orb",
      "subject_ema_crossover",
    ]);
    expect((await repo.findById("subject_orb"))?.enabled).toBe(false);
    expect(
      await connection.db.collection(COLLECTIONS.strategies).countDocuments(),
    ).toBe(2);
  });

  it("refuses anything but an NSE index, writing nothing", async () => {
    await expect(
      provisionSubject(connection.db, {
        symbols: ["NSE:NIFTY50-INDEX", "NSE:RELIANCE-EQ"],
        now: 1,
      }),
    ).rejects.toThrow(/NSE indices only.*RELIANCE-EQ/);
    expect(
      await connection.db.collection(COLLECTIONS.strategies).countDocuments(),
    ).toBe(0);
  });
});
