import { describe, expect, it } from "vitest";
import {
  applyFill,
  unrealizedPnl,
  type Fill,
  type PositionState,
} from "./position-math.js";

const fill = (
  side: "BUY" | "SELL",
  qty: number,
  price: number,
  charges = 0,
): Fill => ({ side, qty, price, charges });

describe("applyFill — long lifecycle (plan/13 §3)", () => {
  it("opens, adds (qty-weighted avg), reduces (avg invariant), closes", () => {
    let p: PositionState = applyFill(null, fill("BUY", 10, 100, 5));
    expect(p).toEqual({
      side: "LONG",
      qty: 10,
      avgEntryPrice: 100,
      realizedPnl: -5,
      status: "OPEN",
    });

    p = applyFill(p, fill("BUY", 10, 110, 5)); // add
    expect(p.qty).toBe(20);
    expect(p.avgEntryPrice).toBe(105); // (10·100 + 10·110)/20
    expect(p.realizedPnl).toBe(-10);

    p = applyFill(p, fill("SELL", 5, 120, 2)); // reduce
    expect(p.qty).toBe(15);
    expect(p.avgEntryPrice).toBe(105); // unchanged on a reduce
    expect(p.realizedPnl).toBe(63); // −10 + (120−105)·5 − 2
    expect(p.status).toBe("OPEN");

    p = applyFill(p, fill("SELL", 15, 120, 3)); // close
    expect(p.qty).toBe(0);
    expect(p.status).toBe("CLOSED");
    expect(p.realizedPnl).toBe(285); // 63 + (120−105)·15 − 3
  });
});

describe("applyFill — short lifecycle (plan/13 §3 sign convention)", () => {
  it("opens short and realizes a profit when price falls", () => {
    let p = applyFill(null, fill("SELL", 10, 100, 5));
    expect(p.side).toBe("SHORT");
    expect(p.realizedPnl).toBe(-5);

    p = applyFill(p, fill("BUY", 10, 90, 2)); // close short lower
    expect(p.status).toBe("CLOSED");
    expect(p.realizedPnl).toBe(93); // −5 + (−1)·(90−100)·10 − 2
  });
});

describe("applyFill — reversal caps at held quantity (engine opens remainder)", () => {
  it("closes the position on an oversized opposite fill", () => {
    const long: PositionState = {
      side: "LONG",
      qty: 10,
      avgEntryPrice: 100,
      realizedPnl: -5,
      status: "OPEN",
    };
    const p = applyFill(long, fill("SELL", 15, 110, 3));
    expect(p.qty).toBe(0);
    expect(p.status).toBe("CLOSED");
    expect(p.realizedPnl).toBe(92); // −5 + (110−100)·10 − 3 ; excess 5 not here
  });
});

describe("unrealizedPnl (plan/13 §5)", () => {
  it("marks a long up and a short up symmetrically", () => {
    expect(
      unrealizedPnl({ side: "LONG", qty: 10, avgEntryPrice: 100 }, 110),
    ).toBe(100);
    expect(
      unrealizedPnl({ side: "SHORT", qty: 10, avgEntryPrice: 100 }, 90),
    ).toBe(100);
  });
});
