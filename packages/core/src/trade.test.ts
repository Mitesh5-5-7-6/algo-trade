import { describe, expect, it } from "vitest";
import {
  applyTradeFill,
  grossPnlFor,
  netPnlFor,
  TradeSchema,
  type Trade,
  type TradeFill,
} from "./trade.js";

/**
 * The two corrections task 2.1 applies to the ported `applyTradeFill`
 * (docs/design/PHASE_2_TRADE_LIFECYCLE.md §5.1).
 *
 * The engine tests exercise the lifecycle through the ports. These exercise
 * the arithmetic directly, because both defects are invisible from outside:
 * a reversal whose costs land on the wrong trade still produces the right
 * number of trades, and a partial exit whose `exitPrice` means "the last
 * tranche" still produces the right `grossPnl`. Nothing fails. The record is
 * simply not what a later reader will assume it is.
 */

const CONTEXT = {
  tradeId: "trd_1",
  strategyId: "str_1",
  symbol: "NSE:X-EQ",
  mode: "paper" as const,
};

const fill = (over: Partial<TradeFill> = {}): TradeFill => ({
  orderId: "ord_1",
  side: "BUY",
  qty: 100,
  price: 100,
  charges: 0,
  slippage: 0,
  filledAt: 1_000,
  ...over,
});

/** Open a LONG of `qty` at `price`, with no costs unless asked for. */
function openLong(qty = 100, price = 100, charges = 0): Trade {
  return applyTradeFill(null, fill({ qty, price, charges }), CONTEXT).trade;
}

describe("a reversal splits the order's cost across both trades (§5.1 Q1)", () => {
  /**
   * One broker order, one fee, two trades. Charging it all to the closing leg
   * leaves that trade paying for an entry it never made and the new trade
   * entering for free — both wrong, in opposite directions, and precisely the
   * numbers D2 keeps separate so cost sensitivity can be measured.
   */
  it("allocates charges pro-rata by quantity", () => {
    const long = openLong(50);
    const { trade, remainder } = applyTradeFill(
      long,
      fill({ side: "SELL", qty: 80, price: 110, charges: 100 }),
      CONTEXT,
    );

    // 50 of 80 closes, 30 opens: 62.5% / 37.5%.
    expect(trade.charges).toBeCloseTo(62.5, 2);
    expect(remainder?.charges).toBeCloseTo(37.5, 2);
  });

  it("allocates slippage the same way", () => {
    const long = openLong(50);
    const { trade, remainder } = applyTradeFill(
      long,
      fill({ side: "SELL", qty: 80, price: 110, slippage: 8 }),
      CONTEXT,
    );

    expect(trade.slippage).toBeCloseTo(5, 2);
    expect(remainder?.slippage).toBeCloseTo(3, 2);
  });

  /**
   * The invariant, and the reason the remainder is taken by subtraction
   * rather than rounded independently: a cost that does not sum to the fill
   * is undetectable downstream, whereas a misallocated paisa is auditable.
   */
  it.each([
    [100, 3, 7],
    [33.33, 1, 3],
    [0.07, 1, 3],
    [12.5, 2, 3],
    [999.99, 7, 9],
  ])(
    "splits %s across %s of %s with the parts summing exactly",
    (charges, closingQty, orderQty) => {
      const long = openLong(closingQty);
      const { trade, remainder } = applyTradeFill(
        long,
        fill({ side: "SELL", qty: orderQty, price: 110, charges }),
        CONTEXT,
      );

      expect(trade.charges + (remainder?.charges ?? 0)).toBeCloseTo(
        charges,
        10,
      );
    },
  );

  /** Not a reversal: the whole cost belongs to the one trade it closed. */
  it("does not split when the fill only closes", () => {
    const long = openLong(100);
    const { trade, remainder } = applyTradeFill(
      long,
      fill({ side: "SELL", qty: 100, price: 110, charges: 40 }),
      CONTEXT,
    );

    expect(trade.charges).toBe(40);
    expect(remainder).toBeNull();
  });

  it("does not split a partial exit either", () => {
    const long = openLong(100);
    const { trade, remainder } = applyTradeFill(
      long,
      fill({ side: "SELL", qty: 30, price: 110, charges: 12 }),
      CONTEXT,
    );

    expect(trade.charges).toBe(12);
    expect(remainder).toBeNull();
  });
});

describe("a partial exit averages the exit price (§5.1 Q2)", () => {
  /** Entry 100 @ 100; exits 30 @ 110, 30 @ 115, 40 @ 120. */
  function exitInThree(): Trade {
    let trade = openLong(100, 100);
    for (const [qty, price] of [
      [30, 110],
      [30, 115],
      [40, 120],
    ] as const) {
      trade = applyTradeFill(
        trade,
        fill({ side: "SELL", qty, price }),
        CONTEXT,
      ).trade;
    }
    return trade;
  }

  it("stores the quantity-weighted mean, not the last tranche", () => {
    const trade = exitInThree();
    // (30×110 + 30×115 + 40×120) / 100
    expect(trade.exitPrice).toBeCloseTo(115.5, 6);
    expect(trade.status).toBe("CLOSED");
    expect(trade.openQuantity).toBe(0);
  });

  /**
   * The point of the whole change. Before it, this arithmetic disagreed with
   * the stored `grossPnl` on any trade that left in pieces, and nothing in
   * the record said which one to believe.
   */
  it("reconciles with grossPnl", () => {
    const trade = exitInThree();
    const derived = grossPnlFor(
      "LONG",
      trade.entryPrice,
      trade.exitPrice ?? 0,
      trade.quantity,
    );

    expect(derived).toBeCloseTo(trade.grossPnl ?? 0, 6);
    expect(trade.grossPnl).toBeCloseTo(1_550, 6);
  });

  it("reconciles for a SHORT too", () => {
    let trade = applyTradeFill(
      null,
      fill({ side: "SELL", qty: 100, price: 120 }),
      CONTEXT,
    ).trade;
    expect(trade.side).toBe("SHORT");

    for (const [qty, price] of [
      [40, 110],
      [60, 100],
    ] as const) {
      trade = applyTradeFill(
        trade,
        fill({ side: "BUY", qty, price }),
        CONTEXT,
      ).trade;
    }

    // (40×110 + 60×100) / 100 = 104
    expect(trade.exitPrice).toBeCloseTo(104, 6);
    expect(
      grossPnlFor(
        "SHORT",
        trade.entryPrice,
        trade.exitPrice ?? 0,
        trade.quantity,
      ),
    ).toBeCloseTo(trade.grossPnl ?? 0, 6);
  });

  it("is just the fill price on a single full exit", () => {
    const long = openLong(100, 100);
    const { trade } = applyTradeFill(
      long,
      fill({ side: "SELL", qty: 100, price: 112.5 }),
      CONTEXT,
    );
    expect(trade.exitPrice).toBe(112.5);
  });

  /**
   * Weighting must not start from a price the trade never exited at. On the
   * first reducing leg there is no prior exit to average against.
   */
  it("does not average against a phantom first leg", () => {
    const long = openLong(100, 100);
    const { trade } = applyTradeFill(
      long,
      fill({ side: "SELL", qty: 30, price: 110 }),
      CONTEXT,
    );
    expect(trade.exitPrice).toBe(110);
    expect(trade.openQuantity).toBe(70);
  });

  it("keeps the latest leg's identity while averaging its price", () => {
    let trade = openLong(100, 100);
    trade = applyTradeFill(
      trade,
      fill({
        side: "SELL",
        qty: 50,
        price: 110,
        orderId: "ord_a",
        filledAt: 2_000,
      }),
      CONTEXT,
    ).trade;
    trade = applyTradeFill(
      trade,
      fill({
        side: "SELL",
        qty: 50,
        price: 120,
        orderId: "ord_b",
        filledAt: 3_000,
        exitReason: "TAKE_PROFIT",
      }),
      CONTEXT,
    ).trade;

    expect(trade.exitPrice).toBeCloseTo(115, 6);
    expect(trade.exitOrderId).toBe("ord_b");
    expect(trade.exitTime).toBe(3_000);
    expect(trade.exitReason).toBe("TAKE_PROFIT");
  });
});

describe("the closed-trade invariants (§5.3)", () => {
  it("netPnl is gross minus charges, and never subtracts slippage", () => {
    // Slippage is the gap between expected and actual fill price, so it is
    // already inside entryPrice and exitPrice — and therefore inside
    // grossPnl. Subtracting it again would double-count.
    expect(netPnlFor(1_000, 150)).toBe(850);

    const long = openLong(100, 100);
    const { trade } = applyTradeFill(
      long,
      fill({ side: "SELL", qty: 100, price: 110, charges: 60, slippage: 25 }),
      CONTEXT,
    );

    expect(trade.grossPnl).toBeCloseTo(1_000, 6);
    expect(trade.netPnl).toBeCloseTo(940, 6);
    expect(trade.slippage).toBeCloseTo(25, 6);
  });

  it("quantity is the peak held, not what remains", () => {
    let trade = openLong(100, 100);
    trade = applyTradeFill(
      trade,
      fill({ side: "SELL", qty: 60, price: 110 }),
      CONTEXT,
    ).trade;

    expect(trade.quantity).toBe(100);
    expect(trade.openQuantity).toBe(40);
  });

  it("a reversal's two trades carry independent identities", () => {
    const long = openLong(50, 100);
    const { trade, remainder } = applyTradeFill(
      long,
      fill({ side: "SELL", qty: 80, price: 110, charges: 100 }),
      CONTEXT,
    );
    expect(trade.status).toBe("CLOSED");
    expect(remainder?.qty).toBe(30);

    const opened = applyTradeFill(null, remainder as TradeFill, {
      ...CONTEXT,
      tradeId: "trd_2",
    }).trade;

    expect(opened.side).toBe("SHORT");
    expect(opened.quantity).toBe(30);
    expect(opened.status).toBe("OPEN");
    // The opening leg paid its share; it did not enter for free.
    expect(opened.charges).toBeCloseTo(37.5, 2);
    expect(trade.charges + opened.charges).toBeCloseTo(100, 6);
  });
});

/**
 * Task 2.1, the audit's drifts 1 and 3 (design §2).
 *
 * What the entry decision stood on: which bar, from which source, and whether
 * its volume could be trusted. Stamped once, at the entry fill, because that
 * is the decision the trade measures — a closing fill made on a different bar
 * must not restate it.
 */
describe("entry provenance and market context (§2 drifts 1 and 3)", () => {
  const PROVENANCE = {
    symbol: "NSE:NIFTY50-INDEX",
    interval: "5m" as const,
    barTs: 900,
    source: "BROKER_HISTORICAL" as const,
    ingestionVersion: 1,
  };

  it("stamps both onto the trade at the entry fill", () => {
    const trade = applyTradeFill(null, fill(), {
      ...CONTEXT,
      dataProvenance: PROVENANCE,
      marketContext: { volumeQuality: "SUSPECT" },
    }).trade;

    expect(trade.dataProvenance).toEqual(PROVENANCE);
    expect(trade.marketContext).toEqual({ volumeQuality: "SUSPECT" });
  });

  it("is not rewritten by the fill that closes the trade", () => {
    const opened = applyTradeFill(null, fill(), {
      ...CONTEXT,
      dataProvenance: PROVENANCE,
      marketContext: { volumeQuality: "SUSPECT" },
    }).trade;
    const closed = applyTradeFill(
      opened,
      fill({ orderId: "ord_2", side: "SELL", price: 110, filledAt: 2_000 }),
      {
        ...CONTEXT,
        dataProvenance: { ...PROVENANCE, barTs: 1_900, source: "LIVE_TICK" },
        marketContext: { volumeQuality: "REAL" },
      },
    ).trade;

    expect(closed.status).toBe("CLOSED");
    expect(closed.dataProvenance).toEqual(PROVENANCE);
    expect(closed.marketContext).toEqual({ volumeQuality: "SUSPECT" });
  });

  it("refuses provenance written as prose", () => {
    const parsed = TradeSchema.safeParse({
      ...openLong(),
      dataProvenance: "LIVE_TICK candles from the FYERS feed",
    });
    expect(parsed.success).toBe(false);
  });
});
