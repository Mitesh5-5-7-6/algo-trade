import { describe, expect, it } from "vitest";
import type { Instrument, Signal } from "@neelkanth/core";
import { buildTradeCard, optionUnderlyingOf } from "./trade-card.js";

const TS = Date.UTC(2026, 10, 18, 5, 0);

const signal = (over: Partial<Signal> = {}): Signal => ({
  signalId: "sig_1",
  strategyId: "str_orb",
  symbol: "NSE:NIFTYBANK-INDEX",
  side: "BUY",
  confidence: 0.7,
  stopLoss: 62_000,
  target: 62_300,
  reason: "close above the opening-range high",
  contextSnapshot: {
    price: 62_100,
    indicators: {},
    session: "open",
    sentiment: 0,
  },
  ts: TS,
  ...over,
});

const option = (
  symbol: string,
  optionType: "CE" | "PE",
  strike: number,
): Instrument => ({
  symbol,
  kind: "OPTION",
  lotSize: 30,
  tickSize: 0.05,
  underlying: "BANKNIFTY",
  expiry: Date.UTC(2026, 10, 24, 10),
  strike,
  optionType,
});

const CE = option("NSE:BANKNIFTY26NOV62100CE", "CE", 62_100);
const PE = option("NSE:BANKNIFTY26NOV62100PE", "PE", 62_100);

describe("the trade card (2026-11-18)", () => {
  it("suggests the ATM call for an index buy, its stop and target in premium at delta 0.5", () => {
    const card = buildTradeCard(signal(), {
      strategyName: "BANK NIFTY ORB",
      contract: CE,
      premium: 410,
    });
    expect(card).toMatchObject({
      basis: "INDEX_SUGGESTED",
      underlying: "NSE:NIFTYBANK-INDEX",
      direction: "BULLISH",
      contract: "NSE:BANKNIFTY26NOV62100CE",
      optionType: "CE",
      strike: 62_100,
      lotSize: 30,
      action: "BUY",
      entry: 410,
      stopLoss: 360, // index risk 100 points × 0.5
      target: 510, // index reward 200 points × 0.5
      stopPoints: 50,
      targetPoints: 100,
      rewardRisk: 2,
      estimated: true,
      assumedDelta: 0.5,
      index: { entry: 62_100, stopLoss: 62_000, target: 62_300 },
      note: null,
    });
  });

  it("suggests the ATM put for an index sell — still a buy, the stop below its premium", () => {
    const card = buildTradeCard(
      signal({ side: "SELL", stopLoss: 62_200, target: 61_900 }),
      { strategyName: "BANK NIFTY ORB", contract: PE, premium: 380 },
    );
    expect(card).toMatchObject({
      direction: "BEARISH",
      contract: "NSE:BANKNIFTY26NOV62100PE",
      optionType: "PE",
      action: "BUY",
      entry: 380,
      stopLoss: 330,
      target: 480,
      rewardRisk: 2,
    });
  });

  it("stops at the smallest premium when the index stop is wider than the premium can fall", () => {
    const card = buildTradeCard(signal({ stopLoss: 61_000 }), {
      strategyName: "ORB",
      contract: CE,
      premium: 200,
    });
    expect(card?.stopLoss).toBe(0.05);
    expect(card?.note).toMatch(/wider than the premium can fall/);
  });

  it("keeps the index levels and says why when the contract is not streaming or not found", () => {
    const silent = buildTradeCard(signal(), {
      strategyName: "ORB",
      contract: CE,
      premium: null,
    });
    expect(silent).toMatchObject({
      contract: "NSE:BANKNIFTY26NOV62100CE",
      entry: null,
      stopLoss: null,
      target: null,
      estimated: false,
      index: { entry: 62_100, stopLoss: 62_000, target: 62_300 },
    });
    expect(silent?.note).toMatch(/not streaming/);
    const missing = buildTradeCard(signal(), {
      strategyName: "ORB",
      contract: null,
      premium: null,
    });
    expect(missing).toMatchObject({ contract: null, optionType: "CE" });
    expect(missing?.note).toMatch(/no CE contract found/);
  });

  it("gives an option strategy's own contract, premium, stop and target unchanged", () => {
    const card = buildTradeCard(
      signal({
        symbol: "NSE:BANKNIFTY26NOV62100PE",
        underlyingSymbol: "NSE:NIFTYBANK-INDEX",
        stopLoss: 300,
        target: 520,
        contextSnapshot: {
          price: 400,
          indicators: {},
          session: "open",
          sentiment: 0,
        },
      }),
      {
        strategyName: "BANKNIFTY Index Option Momentum",
        contract: PE,
        premium: 401,
      },
    );
    expect(card).toMatchObject({
      basis: "OPTION_STRATEGY",
      direction: "BEARISH",
      contract: "NSE:BANKNIFTY26NOV62100PE",
      action: "BUY",
      entry: 400, // the price the signal was made at, not a later tick
      stopLoss: 300,
      target: 520,
      stopPoints: 100,
      targetPoints: 120,
      rewardRisk: 1.2,
      estimated: false,
      index: null,
    });
  });

  it("gives a stock its own levels, on the side the strategy chose", () => {
    const card = buildTradeCard(
      signal({
        symbol: "NSE:RELIANCE-EQ",
        side: "SELL",
        stopLoss: 1_360,
        target: 1_320,
        contextSnapshot: {
          price: 1_345,
          indicators: {},
          session: "open",
          sentiment: 0,
        },
      }),
      { strategyName: "EMA", contract: null, premium: null },
    );
    expect(card).toMatchObject({
      basis: "DIRECT",
      contract: "NSE:RELIANCE-EQ",
      action: "SELL",
      direction: "BEARISH",
      entry: 1_345,
      stopPoints: 15,
      targetPoints: 25,
    });
  });

  it("makes no card for an exit or a hold", () => {
    const context = { strategyName: "x", contract: null, premium: null };
    expect(buildTradeCard(signal({ side: "HOLD" }), context)).toBeNull();
    expect(
      buildTradeCard(signal({ exitReason: "STOP_LOSS" }), context),
    ).toBeNull();
    expect(buildTradeCard(signal({ positionId: "pos_1" }), context)).toBeNull();
  });

  it("names the option underlying of an index symbol", () => {
    expect(optionUnderlyingOf("NSE:NIFTY50-INDEX")).toBe("NIFTY");
    expect(optionUnderlyingOf("NSE:NIFTYBANK-INDEX")).toBe("BANKNIFTY");
    expect(optionUnderlyingOf("NSE:FINNIFTY-INDEX")).toBe("FINNIFTY");
    expect(optionUnderlyingOf("NSE:RELIANCE-EQ")).toBeNull();
  });
});

describe("the trade card as a Telegram message", () => {
  it("says what to buy, at what, with its stop, target and what they rest on", async () => {
    const { formatTradeCard } = await import("./trade-card-message.js");
    const card = buildTradeCard(signal(), {
      strategyName: "BANK NIFTY ORB",
      contract: CE,
      premium: 410,
    });
    if (card === null) throw new Error("no card");
    const message = formatTradeCard(card);
    expect(message.title).toBe("BUY BANKNIFTY26NOV62100CE @ 410");
    expect(message.body.split("\n")).toEqual([
      "BANK NIFTY ORB at 10:30 — close above the opening-range high",
      "Buy price 410 · SL 360 (50 pts) · Target 510 (100 pts) · R:R 2",
      "Lot 30 · expiry 24 Nov",
      "NIFTYBANK-INDEX: entry 62,100 · SL 62,000 · target 62,300",
      "Premium SL and target are estimates from the index levels at delta 0.5; the option also moves with time and volatility.",
    ]);
  });

  it("says when the premium is unknown, and why", async () => {
    const { formatTradeCard } = await import("./trade-card-message.js");
    const card = buildTradeCard(
      signal({ side: "SELL", stopLoss: 62_200, target: 61_900 }),
      {
        strategyName: "ORB",
        contract: PE,
        premium: null,
      },
    );
    if (card === null) throw new Error("no card");
    const message = formatTradeCard(card);
    expect(message.title).toBe(
      "BUY BANKNIFTY26NOV62100PE — bearish signal, premium unknown",
    );
    expect(message.body).toMatch(/is not streaming/);
  });
});
