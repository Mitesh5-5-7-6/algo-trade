import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import {
  COLLECTIONS,
  ensureIndexes,
  ReplayRunsRepository,
  type MongoConnection,
  type ReplayRunDoc,
} from "./index.js";

/**
 * Phase 4 Q2: a replay run is kept in `replay_runs`, in the research database.
 *
 * Untimed, like `trades` — a replay is research evidence, and evidence on an
 * operational TTL shrinks under whoever studies it (ADR §10.4). One document
 * per run, never overwritten: a run is a record of what was measured once.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";

let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_replay_runs",
    "packages/db/src/replay-runs-repository.integration.test.ts",
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
  await connection.db.collection(COLLECTIONS.replayRuns).deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

const run = (over: Partial<ReplayRunDoc> = {}): ReplayRunDoc => ({
  runId: "run_1",
  createdAt: 1_000,
  fingerprint: "a".repeat(64),
  strategyId: "str_ema",
  manifest: { replayVersion: "1", seed: 7 },
  record: { trades: [] },
  ...over,
});

describe("ReplayRunsRepository (§4.8, Q2)", () => {
  it("keeps a run and reads it back", async () => {
    const repo = new ReplayRunsRepository(connection.db);
    expect(await repo.save(run())).toBe(true);
    expect(await repo.findByRunId("run_1")).toEqual(run());
  });

  /** A run is a record of what was measured once — never overwritten. */
  it("refuses a second run under the same id", async () => {
    const repo = new ReplayRunsRepository(connection.db);
    await repo.save(run());
    expect(await repo.save(run({ fingerprint: "b".repeat(64) }))).toBe(false);
    expect((await repo.findByRunId("run_1"))?.fingerprint).toBe("a".repeat(64));
  });

  /** "Was this exact replay run before?" — the question a fingerprint answers. */
  it("finds every run with a fingerprint", async () => {
    const repo = new ReplayRunsRepository(connection.db);
    await repo.save(run({ runId: "run_1" }));
    await repo.save(run({ runId: "run_2", createdAt: 2_000 }));
    await repo.save(run({ runId: "run_3", fingerprint: "c".repeat(64) }));

    const same = await repo.findByFingerprint("a".repeat(64));
    expect(same.map((r) => r.runId)).toEqual(["run_1", "run_2"]);
  });

  it("has NO TTL — replays are research evidence", async () => {
    const indexes = await connection.db
      .collection(COLLECTIONS.replayRuns)
      .indexes();
    expect(indexes.filter((i) => "expireAfterSeconds" in i)).toEqual([]);
  });
});
