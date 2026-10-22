import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import {
  COLLECTIONS,
  ensureIndexes,
  StrategyExperimentsRepository,
  type MongoConnection,
  type StrategyExperimentDoc,
} from "./index.js";

/** Phase 6 D7: counterfactual runs are kept in `strategy_experiments`, once each. */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_strategy_experiments",
    "packages/db/src/strategy-experiments-repository.integration.test.ts",
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
  await connection.db
    .collection(COLLECTIONS.strategyExperiments)
    .deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

const experiment = (
  over: Partial<StrategyExperimentDoc> = {},
): StrategyExperimentDoc => ({
  experimentId: "cf_1",
  kind: "COUNTERFACTUAL",
  createdAt: 1_000,
  fingerprint: "a".repeat(64),
  manifest: { counterfactualVersion: "1" },
  result: { matrix: [] },
  ...over,
});

describe("StrategyExperimentsRepository (6.6, D7)", () => {
  it("keeps an experiment and reads it back", async () => {
    const repo = new StrategyExperimentsRepository(connection.db);
    expect(await repo.save(experiment())).toBe(true);
    expect(await repo.findById("cf_1")).toEqual(experiment());
  });

  it("never overwrites an experiment", async () => {
    const repo = new StrategyExperimentsRepository(connection.db);
    await repo.save(experiment());
    expect(await repo.save(experiment({ fingerprint: "b".repeat(64) }))).toBe(
      false,
    );
    expect((await repo.findById("cf_1"))?.fingerprint).toBe("a".repeat(64));
  });

  it("finds every run of the same experiment by fingerprint", async () => {
    const repo = new StrategyExperimentsRepository(connection.db);
    await repo.save(experiment({ experimentId: "cf_1" }));
    await repo.save(experiment({ experimentId: "cf_2", createdAt: 2_000 }));
    await repo.save(
      experiment({ experimentId: "cf_3", fingerprint: "c".repeat(64) }),
    );
    expect(
      (await repo.findByFingerprint("a".repeat(64))).map((e) => e.experimentId),
    ).toEqual(["cf_1", "cf_2"]);
  });

  it("has NO TTL — experiments are research evidence", async () => {
    const indexes = await connection.db
      .collection(COLLECTIONS.strategyExperiments)
      .indexes();
    expect(indexes.filter((i) => "expireAfterSeconds" in i)).toEqual([]);
  });
});
