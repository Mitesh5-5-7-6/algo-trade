import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  connectMongo,
  ensureIndexes,
  type MongoConnection,
} from "./index.js";

/**
 * Task 2.3 — the `trades` collection is registered, indexed, and untimed.
 *
 * The index declarations are readable in `collections.ts`; what is not
 * readable there is whether `ensureIndexes` actually produced them against a
 * real server, or whether the research collection quietly acquired the TTL
 * that sits on its neighbour. Both are the kind of thing that is true until
 * one day it is not, and neither shows up in a unit test.
 *
 * The TTL assertion is the one that matters. `trade_logs` — declared right
 * beside `trades`, with a similar name and a 90-day expiry — is a standing
 * invitation to put trades in the wrong place. A completed trade is research
 * evidence, and evidence on an operational TTL is a dataset that shrinks
 * under whoever is studying it: the same backtest run two months apart would
 * see different history and report different results, with nothing to
 * indicate why (ARCHITECTURE_DECISION §10.4).
 */

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
const IT_DB = "neelkanth_it_trades_coll";

if (!/^neelkanth_(it|ci)_/.test(IT_DB))
  throw new Error(`refusing to run against "${IT_DB}"`);

let connection: MongoConnection | undefined;
let reachable = false;

beforeAll(async () => {
  try {
    connection = await connectMongo(MONGO_URI, IT_DB);
    await connection.db.dropDatabase();
    await ensureIndexes(connection.db);
    reachable = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (process.env["REQUIRE_INTEGRATION"] === "1")
      throw new Error(
        `trades-collection integration: MongoDB unreachable and REQUIRE_INTEGRATION=1 — ${reason}`,
      );
    process.stderr.write(
      `\n  SKIPPING trades-collection integration (6 tests)\n` +
        `  reason: ${reason}\n  NOTE:   skipped is not passed.\n\n`,
    );
  }
}, 60_000);

afterAll(async () => {
  await connection?.close();
});

/** Index key patterns actually present on `trades`, as JSON for comparison. */
async function tradeIndexes(): Promise<Map<string, Record<string, unknown>>> {
  if (connection === undefined) throw new Error("no connection");
  const found = await connection.db.collection(COLLECTIONS.trades).indexes();
  return new Map(found.map((i) => [JSON.stringify(i.key), i]));
}

describe("the trades collection (§2.3)", () => {
  it("is named `trades`, not `trade_logs`", (ctx) => {
    if (!reachable) return ctx.skip();
    expect(COLLECTIONS.trades).toBe("trades");
    expect(COLLECTIONS.trades).not.toBe(COLLECTIONS.tradeLogs);
  });

  it("enforces one document per tradeId", async (ctx) => {
    if (!reachable) return ctx.skip();
    const byKey = await tradeIndexes();
    const unique = byKey.get(JSON.stringify({ tradeId: 1 }));

    expect(unique).toBeDefined();
    expect(unique?.["unique"]).toBe(true);
  });

  it("indexes the research read pattern and the engine's hot lookups", async (ctx) => {
    if (!reachable) return ctx.skip();
    const byKey = await tradeIndexes();

    for (const key of [
      { strategyId: 1, entryTime: -1 }, // one strategy over a date range
      { symbol: 1, entryTime: -1 },
      { entryTime: -1 },
      { status: 1, strategyId: 1, symbol: 1 }, // the open trade a fill belongs to
      { entryOrderId: 1 }, // restart-durable idempotency (D5)
      { exitOrderId: 1 },
    ]) {
      expect(byKey.has(JSON.stringify(key))).toBe(true);
    }
  });

  /**
   * The assertion this file exists for. A TTL here would not fail anything —
   * it would quietly delete research evidence ninety days on.
   */
  it("has NO TTL on any index", async (ctx) => {
    if (!reachable) return ctx.skip();
    const found = await connection?.db.collection(COLLECTIONS.trades).indexes();
    const timed = (found ?? []).filter((i) => "expireAfterSeconds" in i);

    expect(timed).toEqual([]);
  });

  /** And the contrast that makes the point: its neighbour genuinely is timed. */
  it("sits beside trade_logs, which IS timed — the trap this avoids", async (ctx) => {
    if (!reachable) return ctx.skip();
    const found = await connection?.db
      .collection(COLLECTIONS.tradeLogs)
      .indexes();
    const timed = (found ?? []).filter((i) => "expireAfterSeconds" in i);

    expect(timed).toHaveLength(1);
    expect(timed[0]?.["expireAfterSeconds"]).toBe(90 * 86_400);
  });

  it("is idempotent — a second ensureIndexes changes nothing", async (ctx) => {
    if (!reachable) return ctx.skip();
    const before = await tradeIndexes();
    if (connection !== undefined) await ensureIndexes(connection.db);
    const after = await tradeIndexes();

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });
});
