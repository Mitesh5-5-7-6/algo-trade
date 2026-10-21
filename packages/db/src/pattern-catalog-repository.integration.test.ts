import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PatternDefinition } from "@neelkanth/core";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "./test-support/infra.js";
import {
  COLLECTIONS,
  ensureIndexes,
  PatternCatalogRepository,
  type MongoConnection,
} from "./index.js";

/**
 * Phase 5 D5: `patterns` holds one definition per detector version, written
 * once. A version that comes back meaning something else is a conflict —
 * reported, never written over.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";

let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_pattern_catalog",
    "packages/db/src/pattern-catalog-repository.integration.test.ts",
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
  await connection.db.collection(COLLECTIONS.patterns).deleteMany({});
});

afterAll(async () => {
  await closeProbe(probe);
});

const ORB: PatternDefinition = {
  patternId: "ORB_BREAKOUT",
  detectorVersion: "1.0.0",
  definition:
    "The first N minutes form a range; a later bar closes outside it.",
  defaultParams: { rangeMinutes: 15, minMinutesSinceOpen: 15 },
  volumeBased: false,
};

describe("PatternCatalogRepository (D5)", () => {
  it("adds a definition once, then knows it", async () => {
    const repo = new PatternCatalogRepository(connection.db);
    expect(await repo.register([ORB])).toEqual({
      added: ["ORB_BREAKOUT@1.0.0"],
      known: [],
      conflicts: [],
    });
    expect(await repo.register([ORB])).toEqual({
      added: [],
      known: ["ORB_BREAKOUT@1.0.0"],
      conflicts: [],
    });
    expect(await repo.list()).toEqual([ORB]);
  });

  it("does not care how the default params were written", async () => {
    const repo = new PatternCatalogRepository(connection.db);
    await repo.register([ORB]);
    const reordered = {
      ...ORB,
      defaultParams: { minMinutesSinceOpen: 15, rangeMinutes: 15 },
    };
    expect((await repo.register([reordered])).known).toEqual([
      "ORB_BREAKOUT@1.0.0",
    ]);
  });

  /**
   * The failure this exists for: a rule edited in place. The catalogue keeps
   * what 1.0.0 meant when observations were made under it, and says so.
   */
  it("reports a changed rule under an unchanged version, and keeps the original", async () => {
    const repo = new PatternCatalogRepository(connection.db);
    await repo.register([ORB]);
    const edited = {
      ...ORB,
      defaultParams: { rangeMinutes: 30, minMinutesSinceOpen: 30 },
    };

    const outcome = await repo.register([edited]);
    expect(outcome.added).toEqual([]);
    expect(outcome.conflicts).toEqual([
      {
        patternId: "ORB_BREAKOUT",
        detectorVersion: "1.0.0",
        catalogued: ORB,
        running: edited,
      },
    ]);
    expect(await repo.find("ORB_BREAKOUT", "1.0.0")).toEqual(ORB);
  });

  it("checks without writing", async () => {
    const repo = new PatternCatalogRepository(connection.db);
    expect((await repo.check([ORB])).added).toEqual(["ORB_BREAKOUT@1.0.0"]);
    expect(await repo.list()).toEqual([]);
    await repo.register([ORB]);
    const edited = { ...ORB, definition: "something else" };
    expect((await repo.check([edited])).conflicts).toHaveLength(1);
    expect((await repo.check([ORB])).known).toEqual(["ORB_BREAKOUT@1.0.0"]);
  });

  it("keeps two versions of one pattern side by side", async () => {
    const repo = new PatternCatalogRepository(connection.db);
    const v2 = {
      ...ORB,
      detectorVersion: "2.0.0",
      defaultParams: { rangeMinutes: 30, minMinutesSinceOpen: 30 },
    };
    await repo.register([ORB, v2]);
    expect(await repo.list()).toEqual([ORB, v2]);
    expect(await repo.find("ORB_BREAKOUT", "3.0.0")).toBeNull();
  });
});
