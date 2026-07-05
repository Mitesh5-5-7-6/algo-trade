import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  connectMongo,
  ensureIndexes,
  SettingsRepository,
  type MongoConnection,
} from "./index.js";

/**
 * Integration tests against REAL MongoDB (plan/27 §2). The unique-signalId
 * test is the plan/12 §6 duplicate-execution backstop actually rejecting a
 * duplicate — the single most money-critical index in the system.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/neelkanth_test";

let connection: MongoConnection;

beforeAll(async () => {
  connection = await connectMongo(MONGO_URI);
  await connection.db.dropDatabase(); // clean slate per run
  await ensureIndexes(connection.db);
});

afterAll(async () => {
  await connection.close();
});

describe("ensureIndexes (plan/07 as code)", () => {
  it("is idempotent — a second run changes nothing and throws nothing", async () => {
    await ensureIndexes(connection.db);
  });

  it("creates the unique signalId backstop that rejects a duplicate order (plan/12 §6)", async () => {
    const orders = connection.db.collection(COLLECTIONS.orders);
    await orders.insertOne({
      orderId: "ord_1",
      signalId: "sig_dup",
      status: "PLACED",
      createdAt: Date.now(),
    });
    await expect(
      orders.insertOne({
        orderId: "ord_2",
        signalId: "sig_dup", // same signal — must fail loudly
        status: "PLACED",
        createdAt: Date.now(),
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("creates one-bar-per-symbol/interval/time uniqueness on candles (plan/07)", async () => {
    const candles = connection.db.collection(COLLECTIONS.candles);
    const bar = {
      symbol: "NSE:INFY-EQ",
      interval: "1m",
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      ts: 1_730_000_000_000,
    };
    await candles.insertOne({ ...bar });
    await expect(candles.insertOne({ ...bar })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("puts a TTL index on market_ticks (plan/07 §6 retention)", async () => {
    const indexes = await connection.db
      .collection(COLLECTIONS.marketTicks)
      .indexes();
    const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
  });
});

describe("SettingsRepository (plan/07 settings — the kill flag)", () => {
  it("seeds conservative defaults: trading DISABLED until the operator enables", async () => {
    const repo = new SettingsRepository(connection.db);
    const settings = await repo.getGlobal();
    expect(settings.tradingEnabled).toBe(false);
    expect(settings.scope).toBe("global");
  });

  it("persists the kill flag across a fresh read — restart never resumes silently (plan/12 §4)", async () => {
    const repo = new SettingsRepository(connection.db);
    await repo.setTradingEnabled(true);
    await repo.setTradingEnabled(false); // kill

    const fresh = new SettingsRepository(connection.db); // "restarted" reader
    const settings = await fresh.getGlobal();
    expect(settings.tradingEnabled).toBe(false);
  });

  it("validates merged updates and rejects malformed patches", async () => {
    const repo = new SettingsRepository(connection.db);
    await expect(
      repo.updateGlobal({ capitalAllocation: -1 }),
    ).rejects.toThrow();
    const updated = await repo.updateGlobal({ capitalAllocation: 600_000 });
    expect(updated.capitalAllocation).toBe(600_000);
  });
});
