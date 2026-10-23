import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  ensureIndexes,
  StrategyCandidatesRepository,
  StrategyExperimentsRepository,
  type MongoConnection,
} from "@neelkanth/db";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import { hypothesisFingerprint } from "../validation/hypothesis.js";
import { hypothesis } from "../validation/test-support.js";
import { declareCandidate } from "./candidates.js";

/** Task 13.3 (design D1, spec §5.2): a candidate only from a registered hypothesis, declared once. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;
const SYMBOLS = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"];
// The fixture's claim is about RSI on RSI_REVERSION.
const H = hypothesis({ hypothesisId: "H-0001" });
const DECLARATION = {
  strategyType: "RSI",
  grid: [{}, { period: 21 }],
  symbols: SYMBOLS,
  hypothesisId: "H-0001",
  statement: "RSI, at its default period or a slower one",
};

beforeAll(async () => {
  probe = await probeMongo(MONGO_URI, "neelkanth_it_candidates", "candidates");
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
  await new StrategyExperimentsRepository(connection.db).save({
    experimentId: "H-0001",
    kind: "HYPOTHESIS",
    createdAt: 1,
    fingerprint: hypothesisFingerprint(H),
    manifest: H,
    result: {},
  });
}, 120_000);

afterAll(async () => {
  await closeProbe(probe);
});

describe("strategy_candidates (13.3)", () => {
  it("declares a candidate from a registered hypothesis, once, and refuses the rest", async (ctx) => {
    if (probe?.reachable !== true) return ctx.skip();
    const c = await declareCandidate(connection.db, DECLARATION, 5);
    expect(c).toMatchObject({
      candidateId: "SC-0001",
      strategyType: "RSI",
      grid: [{}, { period: 21 }],
      hypothesisId: "H-0001",
    });
    expect(
      await new StrategyCandidatesRepository(connection.db).findById("SC-0001"),
    ).toEqual(c);

    await expect(
      declareCandidate(connection.db, DECLARATION, 6),
    ).rejects.toThrow(/already declared as SC-0001/);
    await expect(
      declareCandidate(
        connection.db,
        { ...DECLARATION, hypothesisId: "H-0999" },
        6,
      ),
    ).rejects.toThrow(
      /H-0999 is not a registered hypothesis — a candidate cannot come from an unregistered one/,
    );
    await expect(
      declareCandidate(
        connection.db,
        { ...DECLARATION, strategyType: "ORB", grid: [{}] },
        6,
      ),
    ).rejects.toThrow(/H-0001 is about RSI, not ORB/);
    await expect(
      declareCandidate(
        connection.db,
        { ...DECLARATION, grid: [{ periodLength: 21 }] },
        6,
      ),
    ).rejects.toThrow(
      /the candidate is refused: variant 1: RSI does not take periodLength as given/,
    );
    expect(
      await connection.db
        .collection(COLLECTIONS.strategyCandidates)
        .countDocuments(),
    ).toBe(1);

    // Another grid is another candidate.
    const second = await declareCandidate(
      connection.db,
      { ...DECLARATION, grid: [{ period: 7 }] },
      7,
    );
    expect(second.candidateId).toBe("SC-0002");
  }, 120_000);
});
