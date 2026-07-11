import { describe, expect, it } from "vitest";
import { computeCharges, DEFAULT_CHARGES } from "./charges.js";

describe("computeCharges — the Indian cost stack (plan/11 §5)", () => {
  // turnover = 1000 × 100 = 100_000
  const price = 1000;
  const qty = 100;

  it("charges STT and no stamp on a SELL", () => {
    const total = computeCharges(price, qty, "SELL", DEFAULT_CHARGES);
    // brokerage min(20, 30)=20; stt=25; txn=2.97; sebi=0.1;
    // gst=(20+2.97+0.1)·0.18=4.1526; stamp=0
    expect(total).toBeCloseTo(52.2226, 3);
  });

  it("charges stamp and no STT on a BUY", () => {
    const total = computeCharges(price, qty, "BUY", DEFAULT_CHARGES);
    // brokerage 20; stt 0; txn 2.97; sebi 0.1; gst 4.1526; stamp=3
    expect(total).toBeCloseTo(30.2226, 3);
  });

  it("caps brokerage at the flat per-order fee on large turnover", () => {
    // turnover 100k → pct brokerage 30 > flat 20 → capped at 20.
    const total = computeCharges(price, qty, "BUY", DEFAULT_CHARGES);
    const withoutStamp = total - price * qty * DEFAULT_CHARGES.stampPct;
    // brokerage component is bounded, so total stays modest vs turnover.
    expect(withoutStamp).toBeLessThan(30);
  });

  it("uses percentage brokerage when it is below the flat fee", () => {
    // turnover 1000 → pct brokerage 0.3 < flat 20 → 0.3 applies.
    const total = computeCharges(100, 10, "BUY", DEFAULT_CHARGES);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(1); // dominated by the tiny pct brokerage
  });

  it("is configurable — zeroing every rate yields zero cost", () => {
    const free = {
      brokeragePerOrder: 0,
      brokeragePct: 0,
      sttPct: 0,
      exchangeTxnPct: 0,
      sebiPct: 0,
      gstPct: 0,
      stampPct: 0,
    };
    expect(computeCharges(1000, 100, "BUY", free)).toBe(0);
  });
});
