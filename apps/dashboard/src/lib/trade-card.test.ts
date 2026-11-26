import { describe, expect, it } from "vitest";
import {
  bareSymbol,
  cardCheckpoints,
  cardTime,
  describeBasis,
  price,
  type TradeCard,
} from "./trade-card";

const card = (over: Partial<TradeCard> = {}): TradeCard => ({
  signalId: "sig_1",
  strategyId: "str_orb",
  strategyName: "BANK NIFTY ORB",
  ts: Date.UTC(2026, 10, 18, 5, 0),
  basis: "INDEX_SUGGESTED",
  underlying: "NSE:NIFTYBANK-INDEX",
  direction: "BULLISH",
  contract: "NSE:BANKNIFTY26NOV62100CE",
  optionType: "CE",
  strike: 62_100,
  expiry: null,
  lotSize: 30,
  action: "BUY",
  entry: 410,
  stopLoss: 360,
  target: 510,
  stopPoints: 50,
  targetPoints: 100,
  rewardRisk: 2,
  estimated: true,
  assumedDelta: 0.5,
  index: { entry: 62_100, stopLoss: 62_000, target: 62_300 },
  reason: "close above the opening-range high",
  note: null,
  ...over,
});

describe("the trade card on the dashboard", () => {
  it("formats prices, times and symbols", () => {
    expect(price(62_100)).toBe("62,100");
    expect(price(410.5)).toBe("410.5");
    expect(price(null)).toBe("—");
    expect(cardTime(Date.UTC(2026, 10, 18, 5, 0))).toBe("10:30");
    expect(bareSymbol("NSE:BANKNIFTY26NOV62100CE")).toBe(
      "BANKNIFTY26NOV62100CE",
    );
  });

  it("says where the numbers come from", () => {
    expect(describeBasis(card())).toBe(
      "Suggested ATM option; SL and target estimated from the index at delta 0.5",
    );
    expect(describeBasis(card({ estimated: false, assumedDelta: null }))).toBe(
      "Suggested ATM option; its premium is unknown",
    );
    expect(describeBasis(card({ basis: "OPTION_STRATEGY" }))).toBe(
      "The option strategy's own order",
    );
  });
});

describe("live state on the dashboard (2026-11-20)", () => {
  it("says how old a price is", async () => {
    const { age } = await import("./trade-card");
    const now = 1_000_000_000;
    expect(age(now - 5_000, now)).toBe("5s ago");
    expect(age(now - 180_000, now)).toBe("3m ago");
    expect(age(now - 22 * 3_600_000, now)).toBe("22h ago");
    expect(age(null, now)).toBe("no price yet");
  });

  it("places a price between stop and target, for long and short alike", async () => {
    const { progress } = await import("./trade-card");
    expect(progress(500, 300, 700)).toBe(0.5);
    expect(progress(800, 300, 700)).toBe(1); // past the target: full
    expect(progress(200, 300, 700)).toBe(0); // past the stop: empty
    expect(progress(62_400, 62_600, 62_200)).toBe(0.5); // a short
    expect(progress(500, null, 700)).toBeNull();
  });

  it("names how a trade ended", async () => {
    const { describeExit } = await import("./trade-card");
    expect(describeExit("TAKE_PROFIT")).toBe("Target hit");
    expect(describeExit("SESSION_CLOSE")).toBe("Squared off at 15:12");
    expect(describeExit(null)).toBe("Closed");
  });
});

/**
 * The three-part target on the card (PLAN.md 14.17), on the operator's own
 * example: NIFTY 25750 PE bought at 218.01, final target 348.72.
 */
describe("the card's T1 / T2 / T3", () => {
  const option = card({
    basis: "OPTION_STRATEGY",
    underlying: "NSE:NIFTY50-INDEX",
    contract: "NSE:NIFTY26D0125750PE",
    entry: 217.95,
    stopLoss: 163.46,
    target: 348.72,
    index: null,
  });

  it("splits the way from the buy price to the target in equal thirds", () => {
    const levels = cardCheckpoints({
      ...option,
      live: {
        state: "OPEN",
        symbol: "NSE:NIFTY26D0125750PE",
        qty: 325,
        avgEntryPrice: 218.01,
        ltp: 230,
        ltpAt: 1,
        unrealizedPnl: 0,
        stopLoss: 163.46,
        target: 348.72,
        stale: false,
      },
    });
    expect(levels?.t1).toBeCloseTo(261.58, 2);
    expect(levels?.t2).toBeCloseTo(305.15, 2);
    expect(levels?.t3).toBe(348.72);
    expect(levels?.stopAtEntry).toBe(false);
  });

  it("says when the stop has moved to the buy price after T1", () => {
    const levels = cardCheckpoints({
      ...option,
      live: {
        state: "OPEN",
        symbol: "NSE:NIFTY26D0125750PE",
        qty: 325,
        avgEntryPrice: 218.01,
        ltp: 265,
        ltpAt: 1,
        unrealizedPnl: 0,
        stopLoss: 218.01,
        target: 348.72,
        stale: false,
      },
    });
    expect(levels?.stopAtEntry).toBe(true);
  });

  it("uses the card's own numbers before the order fills, and needs a target", () => {
    expect(cardCheckpoints(option)?.t3).toBe(348.72);
    expect(cardCheckpoints({ ...option, target: null })).toBeNull();
  });
});