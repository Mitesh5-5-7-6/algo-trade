import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { applyTradeFill, type Trade, type TradeFill } from "@neelkanth/core";
import {
  connectMongo,
  ensureIndexes,
  TradesRepository,
  type MongoConnection,
} from "./index.js";

/**
 * `TradesRepository` against REAL MongoDB (plan/27 §2).
 *
 * The repository is persistence only — the P&L arithmetic lives in
 * `applyTradeFill` and is unit-tested there. These tests build trade states
 * through that same function, so what is stored is exactly what the Trade
 * Engine would store, and the two can never be tested against different
 * arithmetic.
 */
const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/neelkanth_trades_test";

let connection: MongoConnection;

beforeAll(async () => {
  connection = await connectMongo(MONGO_URI, "neelkanth_it_trades");
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
});

/**
 * Per test, not just per suite.
 *
 * The suite dropped the database once in `beforeAll` and shared it across
 * every test, so `findRecent(1)` could return a trade an earlier test had
 * written. Two fixtures share an `entryTime`, which makes the sort a tie and
 * the winner arbitrary — it passed on the branch this was ported from by
 * luck, not by design.
 */
beforeEach(async () => {
  await connection.db.collection("trades").deleteMany({});
});

afterAll(async () => {
  await connection.close();
});

const context = (tradeId: string, symbol = "NSE:TRADE-EQ") => ({
  tradeId,
  strategyId: "str_trade",
  symbol,
  mode: "paper" as const,
});

const entry = (overrides: Partial<TradeFill> = {}): TradeFill => ({
  orderId: "ord_in",
  side: "BUY",
  qty: 10,
  price: 100,
  charges: 5,
  slippage: 1,
  filledAt: 10_000,
  ...overrides,
});

/** An open trade, as the engine would produce it. */
const openTrade = (tradeId: string, symbol?: string): Trade =>
  applyTradeFill(null, entry(), context(tradeId, symbol)).trade;

describe("TradesRepository — persistence", () => {
  it("saves an open trade and finds it by strategy and symbol", async () => {
    const repo = new TradesRepository(connection.db);
    await repo.save(openTrade("trd_open"));

    const found = await repo.findOpen("str_trade", "NSE:TRADE-EQ");
    expect(found?.tradeId).toBe("trd_open");
    expect(found?.status).toBe("OPEN");
    expect(found?.netPnl).toBeUndefined();
    expect(found?.openQuantity).toBe(10);
  });

  /**
   * A trade is written many times across its life — open, each partial exit,
   * close — so the write path must be an upsert. An insert-only path would
   * throw on the first exit leg.
   */
  it("updates the same trade in place as it progresses", async () => {
    const repo = new TradesRepository(connection.db);
    const open = openTrade("trd_progress");
    await repo.save(open);

    const closed = applyTradeFill(
      open,
      entry({
        orderId: "ord_out",
        side: "SELL",
        price: 110,
        charges: 7,
        slippage: 2,
        filledAt: 20_000,
        exitReason: "TAKE_PROFIT",
      }),
      context("trd_progress"),
    ).trade;
    await repo.save(closed);

    const stored = await repo.findRecent(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      tradeId: "trd_progress",
      status: "CLOSED",
      exitReason: "TAKE_PROFIT",
      grossPnl: 100,
      charges: 12,
      slippage: 3,
      netPnl: 88,
    });
    // One document, not two — the whole point of keying on tradeId.
    const count = await connection.db
      .collection("trades")
      .countDocuments({ tradeId: "trd_progress" });
    expect(count).toBe(1);
  });

  it("refuses to duplicate a trade through open()", async () => {
    const repo = new TradesRepository(connection.db);
    expect(await repo.open(openTrade("trd_dupe"))).toBe(true);
    expect(await repo.open(openTrade("trd_dupe"))).toBe(false);
  });

  it("lists only open trades for boot hydration", async () => {
    const repo = new TradesRepository(connection.db);
    await repo.save(openTrade("trd_h1", "NSE:HYDRA-EQ"));
    const second = openTrade("trd_h2", "NSE:HYDRB-EQ");
    await repo.save(second);
    await repo.save(
      applyTradeFill(
        second,
        entry({
          orderId: "ord_h2",
          side: "SELL",
          price: 105,
          filledAt: 20_000,
          exitReason: "SESSION_CLOSE",
        }),
        context("trd_h2", "NSE:HYDRB-EQ"),
      ).trade,
    );

    const open = (await repo.findAllOpen()).map((t) => t.tradeId);
    expect(open).toContain("trd_h1");
    expect(open).not.toContain("trd_h2");
  });

  /**
   * Half-open like the candle range, so consecutive research periods tile
   * exactly with no trade counted twice at a boundary.
   */
  it("reads a half-open entry-time range, oldest first", async () => {
    const repo = new TradesRepository(connection.db);
    for (const [id, filledAt] of [
      ["trd_r1", 1_000],
      ["trd_r2", 2_000],
      ["trd_r3", 3_000],
    ] as const) {
      await repo.save(
        applyTradeFill(null, entry({ filledAt }), context(id, "NSE:RANGE-EQ"))
          .trade,
      );
    }

    const range = await repo.findRange(1_000, 3_000, {
      symbol: "NSE:RANGE-EQ",
    });
    expect(range.map((t) => t.tradeId)).toEqual(["trd_r1", "trd_r2"]);
  });

  it("returns nothing for an inverted range", async () => {
    const repo = new TradesRepository(connection.db);
    expect(await repo.findRange(3_000, 1_000)).toEqual([]);
  });
});
