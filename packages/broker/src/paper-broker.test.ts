import { describe, expect, it } from "vitest";
import {
  ExecutionOutcomeSchema,
  type BrokerOrderRequest,
} from "@neelkanth/core";
import {
  PaperBroker,
  type PaperBook,
  type PaperBookEntry,
  type PaperBrokerDeps,
} from "./paper-broker.js";

function broker(overrides: Partial<PaperBrokerDeps> = {}): PaperBroker {
  return new PaperBroker({
    readPrice: () => Promise.resolve(100),
    readSessionOpen: () => Promise.resolve(true),
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

const order = (
  overrides: Partial<BrokerOrderRequest> = {},
): BrokerOrderRequest => ({
  clientOrderId: "ord_1",
  symbol: "NSE:RELIANCE-EQ",
  side: "BUY",
  qty: 10,
  type: "MARKET",
  ...overrides,
});

describe("PaperBroker execution (plan/11 §4)", () => {
  it("fills a MARKET buy at the adversely-slipped price with charges", async () => {
    const outcome = await broker({
      slippage: { kind: "percent", pct: 0.001 },
    }).execute(order());
    expect(ExecutionOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(outcome.status).toBe("FILLED");
    if (outcome.status === "FILLED") {
      expect(outcome.fill.filledPrice).toBeCloseTo(100.1, 6); // buy slips up
      expect(outcome.fill.slippage).toBeCloseTo(0.1, 6);
      expect(outcome.fill.charges).toBeGreaterThan(0);
      expect(outcome.fill.clientOrderId).toBe("ord_1");
    }
  });

  it("slips a SELL down and honors a 'none' slippage model", async () => {
    const sell = await broker({
      slippage: { kind: "percent", pct: 0.001 },
    }).execute(order({ side: "SELL" }));
    if (sell.status === "FILLED")
      expect(sell.fill.filledPrice).toBeCloseTo(99.9, 6);

    const exact = await broker({ slippage: { kind: "none" } }).execute(order());
    if (exact.status === "FILLED") expect(exact.fill.filledPrice).toBe(100);
  });

  it("rejects when the market is closed (plan/11 §4.1)", async () => {
    const outcome = await broker({
      readSessionOpen: () => Promise.resolve(false),
    }).execute(order());
    expect(outcome).toMatchObject({ status: "REJECTED" });
    if (outcome.status === "REJECTED") expect(outcome.reason).toMatch(/closed/);
  });

  it("refuses to fabricate a fill when no price is available (plan/11 §9)", async () => {
    const outcome = await broker({
      readPrice: () => Promise.resolve(null),
    }).execute(order());
    expect(outcome).toMatchObject({ status: "REJECTED" });
    if (outcome.status === "REJECTED")
      expect(outcome.reason).toMatch(/no current price/);
  });

  it("fills a LIMIT buy when price satisfies it, at the limit price", async () => {
    const outcome = await broker({
      readPrice: () => Promise.resolve(100),
    }).execute(order({ type: "LIMIT", price: 101 }));
    expect(outcome.status).toBe("FILLED");
    if (outcome.status === "FILLED") {
      expect(outcome.fill.filledPrice).toBe(101);
      expect(outcome.fill.slippage).toBe(0);
    }
  });

  it("holds a LIMIT buy pending when price does not satisfy it", async () => {
    const outcome = await broker({
      readPrice: () => Promise.resolve(100),
    }).execute(order({ type: "LIMIT", price: 99 }));
    expect(outcome.status).toBe("PENDING");
  });
});

describe("PaperBroker status & cancel (plan/12 §8 reconciliation)", () => {
  it("reports a filled order and an unknown one honestly", async () => {
    const b = broker();
    await b.execute(order());
    expect(await b.status("ord_1")).toMatchObject({
      found: true,
      status: "FILLED",
    });
    expect(await b.status("never")).toEqual({
      clientOrderId: "never",
      found: false,
    });
  });

  it("reflects a cancel", async () => {
    const b = broker();
    await b.execute(order({ type: "LIMIT", price: 99 })); // pending
    await b.cancel("ord_1");
    expect((await b.status("ord_1")).status).toBe("CANCELLED");
  });

  it("fills a pending LIMIT on the first crossing tick and reports its update", async () => {
    const book = memoryBook();
    const b = broker({ book, now: () => 1_700_000_000_100 });
    const updates: unknown[] = [];
    b.onOrderUpdate((update) => updates.push(update));
    await b.execute(
      order({ type: "LIMIT", price: 99, clientOrderId: "limit_buy" }),
    );

    await b.onMarketTick({
      symbol: "NSE:OTHER-EQ",
      ltp: 98,
      ts: 1_700_000_000_050,
    });
    await b.onMarketTick({
      symbol: "NSE:RELIANCE-EQ",
      ltp: 99,
      ts: 1_700_000_000_060,
    });

    expect(book.entries.get("limit_buy")).toMatchObject({
      status: "FILLED",
      filledPrice: 99,
      filledQty: 10,
      filledAt: 1_700_000_000_060,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "FILLED",
      fill: { clientOrderId: "limit_buy", filledPrice: 99 },
    });
  });

  it("fills a pending LIMIT sell when the first tick reaches its price", async () => {
    const book = memoryBook();
    const b = broker({ book });
    await b.execute(
      order({
        clientOrderId: "limit_sell",
        side: "SELL",
        type: "LIMIT",
        price: 101,
      }),
    );

    await b.onMarketTick({
      symbol: "NSE:RELIANCE-EQ",
      ltp: 101,
      ts: 1_700_000_000_100,
    });

    expect(book.entries.get("limit_sell")).toMatchObject({
      status: "FILLED",
      filledPrice: 101,
      filledAt: 1_700_000_000_100,
    });
  });

  it("resumes watching a persisted pending LIMIT after a broker restart", async () => {
    const book = memoryBook();
    await broker({ book }).execute(
      order({
        clientOrderId: "limit_restart",
        type: "LIMIT",
        price: 99,
      }),
    );
    const restarted = broker({ book });

    await restarted.onMarketTick({
      symbol: "NSE:RELIANCE-EQ",
      ltp: 98,
      ts: 1_700_000_000_100,
    });

    expect(book.entries.get("limit_restart")).toMatchObject({
      status: "FILLED",
      filledPrice: 99,
    });
    expect(typeof book.entries.get("limit_restart")?.brokerOrderId).toBe(
      "string",
    );
  });

  it("expires pending LIMIT orders at session close and reports cancellation", async () => {
    const book = memoryBook();
    const b = broker({ book });
    const updates: unknown[] = [];
    b.onOrderUpdate((update) => updates.push(update));
    await b.execute(
      order({
        clientOrderId: "limit_expired",
        type: "LIMIT",
        price: 99,
      }),
    );

    await b.expirePendingOrders();

    expect(book.entries.get("limit_expired")).toMatchObject({
      status: "CANCELLED",
      reason: "session closed",
    });
    expect(updates).toEqual([
      { status: "CANCELLED", clientOrderId: "limit_expired" },
    ]);
  });
});

/** An in-memory book, merging as the Mongo one does. */
function memoryBook(): PaperBook & { entries: Map<string, PaperBookEntry> } {
  const entries = new Map<string, PaperBookEntry>();
  return {
    entries,
    record: (entry) => {
      entries.set(entry.clientOrderId, {
        ...(entries.get(entry.clientOrderId) ?? {}),
        ...entry,
      } as PaperBookEntry);
      return Promise.resolve();
    },
    find: (id) => Promise.resolve(entries.get(id) ?? null),
    findPending: (symbol) =>
      Promise.resolve(
        [...entries.values()].filter(
          (entry) =>
            entry.status === "PENDING" &&
            entry.type === "LIMIT" &&
            (symbol === undefined || entry.symbol === symbol),
        ),
      ),
  };
}

describe("the paper broker's book (Phase 14 D3)", () => {
  it("keeps a fill — price, quantity, costs, time — before reporting it", async () => {
    const book = memoryBook();
    let reported = false;
    const recording = {
      ...book,
      record: async (e: Parameters<PaperBook["record"]>[0]) => {
        expect(reported).toBe(false); // written before execute returns
        await book.record(e);
      },
    };
    const outcome = await broker({ book: recording }).execute(order());
    reported = true;
    if (outcome.status !== "FILLED") throw new Error("expected a fill");
    expect(book.entries.get("ord_1")).toMatchObject({
      clientOrderId: "ord_1",
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 10,
      type: "MARKET",
      status: "FILLED",
      filledPrice: outcome.fill.filledPrice,
      filledQty: 10,
      slippage: outcome.fill.slippage,
      charges: outcome.fill.charges,
      filledAt: 1_700_000_000_000,
      brokerOrderId: outcome.fill.brokerOrderId,
    });
  });

  /** G1: after a restart the order is found, with what reconciliation needs to settle it. */
  it("answers a restarted broker's status from the book", async () => {
    const book = memoryBook();
    const first = await broker({ book }).execute(order());
    if (first.status !== "FILLED") throw new Error("expected a fill");
    const restarted = broker({ book }); // a new process: nothing in memory
    expect(await restarted.status("ord_1")).toEqual({
      clientOrderId: "ord_1",
      found: true,
      status: "FILLED",
      brokerOrderId: first.fill.brokerOrderId,
      filledPrice: first.fill.filledPrice,
      filledQty: 10,
      filledAt: first.fill.filledAt,
      slippage: first.fill.slippage,
      charges: first.fill.charges,
    });
    // Without a book, the same restart forgets it.
    await broker().execute(order());
    expect(await broker().status("ord_1")).toEqual({
      clientOrderId: "ord_1",
      found: false,
    });
  });

  it("keeps rejections, pending limits and cancellations too", async () => {
    const book = memoryBook();
    await broker({
      book,
      readSessionOpen: () => Promise.resolve(false),
    }).execute(order({ clientOrderId: "r" }));
    expect(book.entries.get("r")).toMatchObject({
      status: "REJECTED",
      reason: "market is closed",
    });
    await broker({ book }).execute(
      order({ clientOrderId: "l", type: "LIMIT", price: 90 }),
    );
    expect(book.entries.get("l")).toMatchObject({
      status: "PENDING",
      price: 90,
      type: "LIMIT",
    });
    await broker({ book }).cancel("l");
    expect(book.entries.get("l")).toMatchObject({
      status: "CANCELLED",
      price: 90,
    }); // merged, not replaced
    expect(await broker({ book }).status("l")).toMatchObject({
      found: true,
      status: "CANCELLED",
    });
  });

  it("does not create an incomplete book entry when cancelling an unknown order", async () => {
    const book = memoryBook();
    const restarted = broker({ book });
    await restarted.cancel("missing");

    expect(book.entries.size).toBe(0);
    expect(await restarted.status("missing")).toEqual({
      clientOrderId: "missing",
      found: false,
    });
  });

  it("does not report an outcome as known when persisting it fails", async () => {
    const failedBook: PaperBook = {
      record: () => Promise.reject(new Error("database unavailable")),
      find: () => Promise.resolve(null),
      findPending: () => Promise.resolve([]),
    };
    const b = broker({ book: failedBook });

    await expect(b.execute(order())).rejects.toThrow("database unavailable");
    expect(await b.status("ord_1")).toEqual({
      clientOrderId: "ord_1",
      found: false,
    });
  });
});
