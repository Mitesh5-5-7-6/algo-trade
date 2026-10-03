import { describe, expect, it } from "vitest";
import type { Trade } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import { TradeEngine } from "./trade-engine.js";
import type { TradePorts } from "./ports.js";

/**
 * Task 2.4 — a redelivered fill must change nothing (design D5).
 *
 * The existing suite proves this within one process, which is the easy half.
 * The half that matters is a redelivery that arrives **after a restart**: the
 * broker repeats an update, or the process comes back and re-reads what it did
 * not finish. In-process memory is gone by then, so an in-memory guard alone
 * proves only that the guard exists — not that the invariant holds.
 *
 * The failure it prevents is not a duplicate row. It is a phantom trade in the
 * wrong direction: a redelivered CLOSING fill, arriving when no open trade is
 * in memory, is indistinguishable from a fresh opening fill.
 */

const SYMBOL = "NSE:IDEM-EQ";
const STRATEGY = "str_idem";

/** A store shared across "process lifetimes", like the real collection. */
function store() {
  const rows = new Map<string, Trade>();
  const ports: TradePorts = {
    saveTrade: (trade) => {
      rows.set(trade.tradeId, trade);
      return Promise.resolve();
    },
    loadOpenTrades: () =>
      Promise.resolve([...rows.values()].filter((t) => t.status === "OPEN")),
    // The runtime resolves this from the Position Engine after it has
    // applied the same fill; here a stable stand-in is enough.
    resolvePositionId: () => "pos_idem",
    // Mirrors `TradesRepository.findByOrderId`: any folded order, plus the
    // entry and latest exit for trades written before `orderIds` existed.
    findTradeByOrderId: (orderId) =>
      Promise.resolve(
        [...rows.values()].find(
          (t) =>
            t.orderIds.includes(orderId) ||
            t.entryOrderId === orderId ||
            t.exitOrderId === orderId,
        ) ?? null,
      ),
  };
  return { rows, ports };
}

/** One process lifetime over a shared store. */
function lifetime(shared: ReturnType<typeof store>) {
  const errors: Record<string, unknown>[] = [];
  let seq = 0;
  const engine = new TradeEngine({
    ports: shared.ports,
    nextTradeId: () => {
      seq += 1;
      return `trd_${String(seq)}`;
    },
    onError: (_error, context) => errors.push(context),
  });
  return { engine, errors };
}

const fill = (
  over: Partial<EventPayload<"ORDER_FILLED">> = {},
): EventPayload<"ORDER_FILLED"> => ({
  orderId: "ord_entry",
  strategyId: STRATEGY,
  symbol: SYMBOL,
  side: "BUY",
  qty: 100,
  filledPrice: 100,
  slippage: 0,
  charges: 0,
  filledAt: 1_000,
  mode: "paper",
  ts: 1_000,
  ...over,
});

describe("a redelivered fill changes nothing, across a restart", () => {
  /**
   * The worst case, and the reason this task is not just a second copy of the
   * in-process test. After a close the trade leaves memory. A redelivered
   * closing fill then looks exactly like an opening fill on the other side,
   * and the engine would record a SHORT that was never entered.
   */
  it("does not invent a phantom trade from a redelivered closing fill", async () => {
    const shared = store();

    const first = lifetime(shared);
    await first.engine.onOrderFilled(fill());
    await first.engine.onOrderFilled(
      fill({ orderId: "ord_exit", side: "SELL", filledAt: 2_000 }),
    );
    expect(shared.rows.size).toBe(1);
    expect([...shared.rows.values()][0]?.status).toBe("CLOSED");

    // Restart. The broker repeats the closing update.
    const second = lifetime(shared);
    await second.engine.hydrate();
    await second.engine.onOrderFilled(
      fill({ orderId: "ord_exit", side: "SELL", filledAt: 2_000 }),
    );

    expect(shared.rows.size).toBe(1);
    expect(second.engine.getOpen(STRATEGY, SYMBOL)).toBeNull();
    expect(second.errors).toEqual([]);
  });

  /**
   * The open case: a restart mid-position, then the entry fill again. Folding
   * it twice would double the quantity and halve the apparent entry price —
   * a position the system never held, recorded as fact.
   */
  it("does not fold an entry fill in twice after a restart", async () => {
    const shared = store();

    const first = lifetime(shared);
    await first.engine.onOrderFilled(fill());
    const afterFirst = [...shared.rows.values()][0];
    expect(afterFirst?.quantity).toBe(100);

    const second = lifetime(shared);
    await second.engine.hydrate();
    await second.engine.onOrderFilled(fill());

    const open = second.engine.getOpen(STRATEGY, SYMBOL);
    expect(open?.quantity).toBe(100);
    expect(open?.openQuantity).toBe(100);
    expect(open?.entryPrice).toBe(100);
    expect(shared.rows.size).toBe(1);
  });

  it("still applies a genuinely new fill after a restart", async () => {
    const shared = store();

    const first = lifetime(shared);
    await first.engine.onOrderFilled(fill());

    const second = lifetime(shared);
    await second.engine.hydrate();
    await second.engine.onOrderFilled(
      fill({
        orderId: "ord_exit",
        side: "SELL",
        filledPrice: 110,
        filledAt: 2_000,
      }),
    );

    const stored = [...shared.rows.values()][0];
    expect(stored?.status).toBe("CLOSED");
    expect(stored?.grossPnl).toBeCloseTo(1_000, 6);
    expect(second.engine.getOpen(STRATEGY, SYMBOL)).toBeNull();
  });

  /** Unchanged behaviour: within one process, the in-memory guard still holds. */
  it("ignores a redelivery within one process", async () => {
    const shared = store();
    const only = lifetime(shared);

    await only.engine.onOrderFilled(fill());
    await only.engine.onOrderFilled(fill());

    expect(shared.rows.size).toBe(1);
    expect(only.engine.getOpen(STRATEGY, SYMBOL)?.quantity).toBe(100);
  });

  /**
   * Two different orders at the same instant are two fills, not a redelivery.
   * Deduping on timing rather than identity would silently drop the second.
   */
  it("does not confuse two distinct orders for a redelivery", async () => {
    const shared = store();
    const only = lifetime(shared);

    await only.engine.onOrderFilled(fill({ orderId: "ord_a", qty: 40 }));
    await only.engine.onOrderFilled(fill({ orderId: "ord_b", qty: 60 }));

    expect(only.engine.getOpen(STRATEGY, SYMBOL)?.openQuantity).toBe(100);
  });

  /**
   * A durable check costs a read per unseen fill. It must not run for one the
   * engine already knows about, or every fill in a session pays for it.
   */
  it("consults the store only when memory does not already know", async () => {
    const shared = store();
    let lookups = 0;
    const counting: TradePorts = {
      ...shared.ports,
      findTradeByOrderId: (orderId) => {
        lookups += 1;
        return shared.ports.findTradeByOrderId(orderId);
      },
    };

    const engine = new TradeEngine({
      ports: counting,
      nextTradeId: () => "trd_1",
      onError: () => undefined,
    });

    await engine.onOrderFilled(fill());
    const afterFirst = lookups;
    await engine.onOrderFilled(fill());

    expect(lookups).toBe(afterFirst);
  });
});

describe("hydration pre-seeds the guard", () => {
  /**
   * Correctness does not depend on this — the durable fallback would catch a
   * redelivery anyway. What it buys is the read: redeliveries cluster right
   * after a restart, which is exactly when the store is busiest being
   * hydrated by everything else.
   *
   * Without the assertion the seeding is unjustified code, so it is pinned
   * here as the optimisation it is rather than left looking load-bearing.
   */
  it("costs no lookup for an order hydration already knew", async () => {
    const shared = store();

    const first = lifetime(shared);
    await first.engine.onOrderFilled(fill());

    let lookups = 0;
    const counting: TradePorts = {
      ...shared.ports,
      findTradeByOrderId: (orderId) => {
        lookups += 1;
        return shared.ports.findTradeByOrderId(orderId);
      },
    };
    const second = new TradeEngine({
      ports: counting,
      nextTradeId: () => "trd_never",
      onError: () => undefined,
    });

    await second.hydrate();
    await second.onOrderFilled(fill());

    expect(lookups).toBe(0);
    expect(second.getOpen(STRATEGY, SYMBOL)?.quantity).toBe(100);
  });

  /** A fill hydration could not have known still reaches the store. */
  it("still looks up an order hydration never saw", async () => {
    const shared = store();
    const first = lifetime(shared);
    await first.engine.onOrderFilled(fill());

    let lookups = 0;
    const counting: TradePorts = {
      ...shared.ports,
      findTradeByOrderId: (orderId) => {
        lookups += 1;
        return shared.ports.findTradeByOrderId(orderId);
      },
    };
    const second = new TradeEngine({
      ports: counting,
      nextTradeId: () => "trd_2",
      onError: () => undefined,
    });

    await second.hydrate();
    await second.onOrderFilled(fill({ orderId: "ord_exit", side: "SELL" }));

    expect(lookups).toBe(1);
  });
});

describe("entry ↔ exit linkage (§2.5)", () => {
  /**
   * `Signal → Order → Trade → Position`, navigable from the trade — the
   * direction research reads (D4). Without these three ids, reconstructing
   * "what did this trade make, and why did it end?" means joining positions
   * to orders with no foreign key and inferring the closing fill from
   * `closedAt` (CURRENT_STATE §3.4).
   */
  it("records both order ids and the position across a round trip", async () => {
    const shared = store();
    const only = lifetime(shared);

    await only.engine.onOrderFilled(fill({ orderId: "ord_in" }));
    await only.engine.onOrderFilled(
      fill({
        orderId: "ord_out",
        side: "SELL",
        filledPrice: 110,
        filledAt: 2_000,
      }),
    );

    const trade = [...shared.rows.values()][0];
    expect(trade).toMatchObject({
      entryOrderId: "ord_in",
      exitOrderId: "ord_out",
      positionId: "pos_idem",
      status: "CLOSED",
    });
  });

  /**
   * The position is gone from memory by the time a closing fill is applied,
   * so resolving it again would return null. Spreading the open trade is what
   * keeps the link — this pins that it is not re-resolved and blanked.
   */
  it("keeps positionId when the position is no longer resolvable", async () => {
    const shared = store();
    let resolvable = true;
    const ports: TradePorts = {
      ...shared.ports,
      resolvePositionId: () => (resolvable ? "pos_entry" : null),
    };
    const engine = new TradeEngine({
      ports,
      nextTradeId: () => "trd_1",
      onError: () => undefined,
    });

    await engine.onOrderFilled(fill({ orderId: "ord_in" }));
    resolvable = false;
    await engine.onOrderFilled(
      fill({ orderId: "ord_out", side: "SELL", filledAt: 2_000 }),
    );

    expect([...shared.rows.values()][0]?.positionId).toBe("pos_entry");
  });

  /** An unresolvable position must not stop the trade being recorded. */
  it("still records a trade when no position can be resolved", async () => {
    const shared = store();
    const engine = new TradeEngine({
      ports: { ...shared.ports, resolvePositionId: () => null },
      nextTradeId: () => "trd_1",
      onError: () => undefined,
    });

    await engine.onOrderFilled(fill());

    const trade = [...shared.rows.values()][0];
    expect(trade?.entryOrderId).toBe("ord_entry");
    expect(trade?.positionId).toBeUndefined();
  });

  /**
   * A reversal's two trades belong to the same (strategy, symbol) and so to
   * the same position — but they are independent outcomes, and each must
   * carry the link itself rather than one being reachable only through the
   * other.
   */
  it("gives both halves of a reversal their own linkage", async () => {
    const shared = store();
    const only = lifetime(shared);

    await only.engine.onOrderFilled(fill({ orderId: "ord_in", qty: 50 }));
    await only.engine.onOrderFilled(
      fill({
        orderId: "ord_flip",
        side: "SELL",
        qty: 80,
        filledPrice: 110,
        filledAt: 2_000,
      }),
    );

    const all = [...shared.rows.values()];
    expect(all).toHaveLength(2);
    const closed = all.find((t) => t.status === "CLOSED");
    const opened = all.find((t) => t.status === "OPEN");

    expect(closed).toMatchObject({
      entryOrderId: "ord_in",
      exitOrderId: "ord_flip",
      positionId: "pos_idem",
    });
    // The reversal's opening leg entered on the same order that closed the
    // first trade — that is the fact, and it must be recorded as such.
    expect(opened).toMatchObject({
      entryOrderId: "ord_flip",
      side: "SHORT",
      positionId: "pos_idem",
    });
  });
});

describe("exitReason is recorded, never inferred (§2.6, D6)", () => {
  /**
   * A stop and a session square-off at the same price are the same number and
   * entirely different events: one is the strategy's own risk rule working,
   * the other is the clock running out on a position that never resolved. A
   * dataset that cannot separate them will conclude the stops are fine.
   */
  it.each([["STOP_LOSS"], ["TAKE_PROFIT"], ["SESSION_CLOSE"]] as const)(
    "carries %s from the fill onto the closed trade",
    async (reason) => {
      const shared = store();
      const only = lifetime(shared);

      await only.engine.onOrderFilled(fill({ orderId: "ord_in" }));
      await only.engine.onOrderFilled(
        fill({
          orderId: "ord_out",
          side: "SELL",
          filledPrice: 110,
          filledAt: 2_000,
          exitReason: reason,
        }),
      );

      const trade = [...shared.rows.values()][0];
      expect(trade?.status).toBe("CLOSED");
      expect(trade?.exitReason).toBe(reason);
    },
  );

  /**
   * Absent is the honest value. A trade closed by something that never said
   * why must not be handed a reason it did not have — that is a claim in the
   * research dataset no component ever made.
   */
  it("leaves it absent when the fill states no reason", async () => {
    const shared = store();
    const only = lifetime(shared);

    await only.engine.onOrderFilled(fill({ orderId: "ord_in" }));
    await only.engine.onOrderFilled(
      fill({ orderId: "ord_out", side: "SELL", filledAt: 2_000 }),
    );

    const trade = [...shared.rows.values()][0];
    expect(trade?.status).toBe("CLOSED");
    expect(trade?.exitReason).toBeUndefined();
  });

  /** An entry fill has nothing to explain, and must not borrow one. */
  it("does not put a reason on an open trade", async () => {
    const shared = store();
    const only = lifetime(shared);

    await only.engine.onOrderFilled(
      fill({ orderId: "ord_in", exitReason: "STOP_LOSS" }),
    );

    expect([...shared.rows.values()][0]?.exitReason).toBeUndefined();
  });
});

/**
 * Limit L1 (design §5.7): every leg is recognised after a restart, not just
 * the entry and the latest exit.
 */
describe("every leg of a trade is recognised after a restart (§2.4, L1)", () => {
  /**
   * An add redelivered after a restart was unrecognisable — not the entry, not
   * an exit — and was folded in again: a position the system never held.
   */
  it("does not fold a redelivered ADD fill in twice", async () => {
    const shared = store();
    const first = lifetime(shared);
    await first.engine.onOrderFilled(fill());
    await first.engine.onOrderFilled(
      fill({ orderId: "ord_add", qty: 50, filledPrice: 110, filledAt: 1_500 }),
    );

    const second = lifetime(shared);
    await second.engine.hydrate();
    await second.engine.onOrderFilled(
      fill({ orderId: "ord_add", qty: 50, filledPrice: 110, filledAt: 1_500 }),
    );

    const open = second.engine.getOpen(STRATEGY, SYMBOL);
    expect(open?.quantity).toBe(150);
    expect(open?.openQuantity).toBe(150);
    expect(open?.entryPrice).toBeCloseTo((100 * 100 + 50 * 110) / 150, 9);
  });

  /**
   * The phantom again, by a different road. The trade is CLOSED, so it is not
   * hydrated, and its middle exit leg is no longer its `exitOrderId`. That leg
   * redelivered found nothing, and opened a SHORT that was never entered.
   */
  it("does not open a phantom from a closed trade's earlier exit leg", async () => {
    const shared = store();
    const first = lifetime(shared);
    await first.engine.onOrderFilled(fill());
    await first.engine.onOrderFilled(
      fill({ orderId: "ord_out1", side: "SELL", qty: 50, filledAt: 2_000 }),
    );
    await first.engine.onOrderFilled(
      fill({ orderId: "ord_out2", side: "SELL", qty: 50, filledAt: 3_000 }),
    );
    expect([...shared.rows.values()][0]?.status).toBe("CLOSED");

    const second = lifetime(shared);
    await second.engine.hydrate();
    await second.engine.onOrderFilled(
      fill({ orderId: "ord_out1", side: "SELL", qty: 50, filledAt: 2_000 }),
    );

    expect(shared.rows.size).toBe(1);
    expect(second.engine.getOpen(STRATEGY, SYMBOL)).toBeNull();
  });

  /**
   * Hydration already holds every open trade's legs, so a redelivered add —
   * and redeliveries cluster right after a restart — costs no read.
   */
  it("pre-seeds every leg of an open trade at hydration", async () => {
    const shared = store();
    const first = lifetime(shared);
    await first.engine.onOrderFilled(fill());
    await first.engine.onOrderFilled(
      fill({ orderId: "ord_add", qty: 50, filledAt: 1_500 }),
    );

    let lookups = 0;
    const counted: TradePorts = {
      ...shared.ports,
      findTradeByOrderId: (orderId) => {
        lookups += 1;
        return shared.ports.findTradeByOrderId(orderId);
      },
    };
    const engine = new TradeEngine({
      ports: counted,
      nextTradeId: () => "trd_unused",
      onError: () => undefined,
    });
    await engine.hydrate();
    await engine.onOrderFilled(
      fill({ orderId: "ord_add", qty: 50, filledAt: 1_500 }),
    );

    expect(lookups).toBe(0);
  });
});
