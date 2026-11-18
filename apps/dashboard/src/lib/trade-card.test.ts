import { describe, expect, it } from "vitest";
import {
  bareSymbol,
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
