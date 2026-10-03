import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectMongo,
  ensureIndexes,
  TradesRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { TradeEngine } from "@neelkanth/engines";
import type { EventPayload } from "@neelkanth/contracts";
import { STRICT } from "../test-support/infra.js";

/**
 * Task 2.7 — Phase 2's "done when", against real Mongo.
 *
 * > Every completed position produces exactly one complete Trade.
 *
 * The engine tests prove the arithmetic against a fake store. This proves the
 * sentence: that a round trip leaves exactly one document, that it holds every
 * field research needs, and that replaying the fills changes nothing. The
 * unique index on `tradeId` and the real `save` upsert only exist here, and
 * "exactly one" is a claim about them, not about a Map.
 */

const IT_DB = "neelkanth_it_round_trip";
if (!/^neelkanth_(it|ci)_/.test(IT_DB))
  throw new Error(`refusing to run against "${IT_DB}"`);

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";

const STRATEGY = "str_round";
const SYMBOL = "NSE:ROUND-EQ";
const POSITION = "pos_round";

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
    if (STRICT)
      throw new Error(
        `trade round trip: MongoDB unreachable and REQUIRE_INTEGRATION=1 — ${reason}`,
      );
    process.stderr.write(
      `\n  SKIPPING trade round-trip integration (7 tests)\n` +
        `  reason: ${reason}\n  NOTE:   skipped is not passed.\n\n`,
    );
  }
}, 60_000);

afterAll(async () => {
  await connection?.close();
});

beforeEach(async () => {
  if (connection !== undefined)
    await connection.db.collection("trades").deleteMany({});
});

/** A Trade Engine over the real repository, as the runtime wires it. */
function engineOver(repo: TradesRepository, idPrefix = "trd") {
  const errors: Record<string, unknown>[] = [];
  let seq = 0;
  const engine = new TradeEngine({
    ports: {
      saveTrade: (trade) => repo.save(trade),
      loadOpenTrades: () => repo.findAllOpen(),
      findTradeByOrderId: (orderId) => repo.findByOrderId(orderId),
      resolvePositionId: () => POSITION,
    },
    nextTradeId: () => {
      seq += 1;
      return `${idPrefix}_${String(seq)}`;
    },
    onError: (_error, context) => errors.push(context),
  });
  return { engine, errors };
}

const fill = (
  over: Partial<EventPayload<"ORDER_FILLED">> = {},
): EventPayload<"ORDER_FILLED"> => ({
  orderId: "ord_in",
  strategyId: STRATEGY,
  symbol: SYMBOL,
  side: "BUY",
  qty: 100,
  filledPrice: 100,
  slippage: 2,
  charges: 15,
  filledAt: 1_000,
  mode: "paper",
  ts: 1_000,
  ...over,
});

const exitFill = () =>
  fill({
    orderId: "ord_out",
    side: "SELL",
    filledPrice: 110,
    charges: 18,
    slippage: 3,
    filledAt: 2_000,
    exitReason: "TAKE_PROFIT",
    strategyVersion: "v2",
  });

describe("a completed position produces exactly one complete Trade (§2.7)", () => {
  it("stores one document with every field research needs", async (ctx) => {
    if (!reachable || connection === undefined) return ctx.skip();
    const repo = new TradesRepository(connection.db);
    const { engine, errors } = engineOver(repo);

    await engine.onOrderFilled(fill({ strategyVersion: "v2" }));
    await engine.onOrderFilled(exitFill());

    expect(errors).toEqual([]);
    const stored = await repo.findRecent(10);
    expect(stored).toHaveLength(1);

    expect(stored[0]).toMatchObject({
      strategyId: STRATEGY,
      symbol: SYMBOL,
      side: "LONG",
      status: "CLOSED",
      // Linkage (2.5) — Signal → Order → Trade → Position, from the trade.
      entryOrderId: "ord_in",
      exitOrderId: "ord_out",
      positionId: POSITION,
      // Identity that a later strategy edit cannot restate (2.8).
      strategyVersion: "v2",
      // Why it ended, recorded rather than inferred (2.6).
      exitReason: "TAKE_PROFIT",
      quantity: 100,
      openQuantity: 0,
      entryPrice: 100,
      exitPrice: 110,
    });
  });

  /**
   * What the entry stood on (§2.1, design §2 drifts 1 and 3), as a structured
   * reference that survives Mongo — not prose a later study would have to
   * parse, and not flattened by the round trip through the repository.
   */
  it("stores the entry's bar and volume quality as a structured reference", async (ctx) => {
    if (!reachable || connection === undefined) return ctx.skip();
    const repo = new TradesRepository(connection.db);
    const { engine, errors } = engineOver(repo);
    const bar = {
      symbol: SYMBOL,
      interval: "5m" as const,
      barTs: 900,
      source: "BROKER_HISTORICAL" as const,
      ingestionVersion: 1,
    };

    await engine.onOrderFilled(
      fill({
        dataProvenance: bar,
        marketContext: { volumeQuality: "SUSPECT" },
      }),
    );
    await engine.onOrderFilled(exitFill());

    expect(errors).toEqual([]);
    const [stored] = await repo.findRecent(1);
    expect(stored?.dataProvenance).toEqual(bar);
    expect(stored?.marketContext).toEqual({ volumeQuality: "SUSPECT" });
  });

  /**
   * Costs beside the result, not folded into it (D2). "Would this strategy
   * survive doubled brokerage?" cannot be asked of a number that already
   * absorbed the brokerage.
   */
  it("keeps costs separable from the outcome", async (ctx) => {
    if (!reachable || connection === undefined) return ctx.skip();
    const repo = new TradesRepository(connection.db);
    const { engine } = engineOver(repo);

    await engine.onOrderFilled(fill());
    await engine.onOrderFilled(exitFill());

    const [trade] = await repo.findRecent(1);
    expect(trade?.grossPnl).toBeCloseTo(1_000, 6);
    expect(trade?.charges).toBeCloseTo(33, 6);
    expect(trade?.netPnl).toBeCloseTo(967, 6);
    // Slippage is kept for measurement and never subtracted — it is already
    // inside the fill prices, so removing it again would double-count.
    expect(trade?.slippage).toBeCloseTo(5, 6);
  });

  it("is still exactly one trade when both fills are replayed", async (ctx) => {
    if (!reachable || connection === undefined) return ctx.skip();
    const repo = new TradesRepository(connection.db);
    const { engine } = engineOver(repo);

    await engine.onOrderFilled(fill());
    await engine.onOrderFilled(exitFill());
    const after = await repo.findRecent(10);

    await engine.onOrderFilled(fill());
    await engine.onOrderFilled(exitFill());

    expect(await repo.findRecent(10)).toEqual(after);
  });

  /**
   * The restart case, end to end: a redelivered CLOSING fill arriving with an
   * empty in-memory guard must not open a phantom SHORT.
   */
  it("survives a restart without inventing a second trade", async (ctx) => {
    if (!reachable || connection === undefined) return ctx.skip();
    const repo = new TradesRepository(connection.db);

    const first = engineOver(repo, "a");
    await first.engine.onOrderFilled(fill());
    await first.engine.onOrderFilled(exitFill());

    const second = engineOver(repo, "b");
    await second.engine.hydrate();
    await second.engine.onOrderFilled(exitFill());

    const stored = await repo.findRecent(10);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tradeId).toBe("a_1");
    expect(second.errors).toEqual([]);
  });

  it("resumes an open trade after a restart rather than starting a second", async (ctx) => {
    if (!reachable || connection === undefined) return ctx.skip();
    const repo = new TradesRepository(connection.db);

    const first = engineOver(repo, "a");
    await first.engine.onOrderFilled(fill());

    const second = engineOver(repo, "b");
    await second.engine.hydrate();
    await second.engine.onOrderFilled(exitFill());

    const stored = await repo.findRecent(10);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ tradeId: "a_1", status: "CLOSED" });
  });

  /** A reversal is two outcomes, and both must be readable as such. */
  it("records a reversal as two trades with costs summing to the fill", async (ctx) => {
    if (!reachable || connection === undefined) return ctx.skip();
    const repo = new TradesRepository(connection.db);
    const { engine } = engineOver(repo);

    await engine.onOrderFilled(fill({ qty: 50, charges: 0, slippage: 0 }));
    await engine.onOrderFilled(
      fill({
        orderId: "ord_flip",
        side: "SELL",
        qty: 80,
        filledPrice: 110,
        charges: 100,
        slippage: 0,
        filledAt: 2_000,
        exitReason: "STRATEGY_EXIT",
      }),
    );

    const stored = await repo.findRecent(10);
    expect(stored).toHaveLength(2);

    const closed = stored.find((t) => t.status === "CLOSED");
    const opened = stored.find((t) => t.status === "OPEN");
    expect(closed?.exitReason).toBe("STRATEGY_EXIT");
    expect(opened?.side).toBe("SHORT");
    expect(opened?.quantity).toBe(30);
    // 62.5% / 37.5% of one order's cost, summing to what was charged.
    expect((closed?.charges ?? 0) + (opened?.charges ?? 0)).toBeCloseTo(100, 6);
  });
});
