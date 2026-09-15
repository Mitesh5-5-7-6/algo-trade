import { describe, expect, it } from "vitest";
import type { MarketContext, OptionChainSnapshot } from "@neelkanth/core";
import {
  indexOptionMomentumScalper,
  IndexOptionMomentumScalperParamsSchema,
} from "./index-option-momentum-scalper.js";

const params = IndexOptionMomentumScalperParamsSchema.parse({
  underlying: "NIFTY",
  minOI: 100,
  minOptionVolume: 100,
  minOIChange: 10,
  skipOpenMinutes: 0,
  minOptionPriceChangePct: 0.005,
});

function context(
  ts: number,
  close: number,
  option: {
    callLtp: number;
    callVolume: number;
    callOI: number;
    callChangeOI: number;
  },
): MarketContext {
  const candles = Array.from({ length: 5 }, (_, index) => ({
    symbol: "NSE:NIFTY50-INDEX",
    interval: "1m" as const,
    open: 100 + index,
    high: 105 + index,
    low: 99 + index,
    close: 104 + index,
    volume: 100,
    ts: ts - (5 - index) * 60_000,
  }));
  const candle = {
    symbol: "NSE:NIFTY50-INDEX",
    interval: "1m" as const,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 150,
    ts,
  };
  const chain: OptionChainSnapshot = {
    underlying: "NIFTY",
    expiry: ts + 86_400_000,
    asOf: ts,
    spot: close,
    rows: [
      {
        strike: 110,
        callOI: option.callOI,
        putOI: 120,
        callChangeOI: option.callChangeOI,
        putChangeOI: 5,
        callLtp: option.callLtp,
        callVolume: option.callVolume,
        callBid: option.callLtp - 0.5,
        callAsk: option.callLtp + 0.5,
        putLtp: 20,
        putVolume: 200,
        putBid: 19.5,
        putAsk: 20.5,
      },
    ],
  };
  return {
    symbol: "NSE:NIFTY50-INDEX",
    interval: "1m",
    candle,
    candles: [...candles, candle],
    indicators: { ema9: 106, ema20: 104, vwap: 103, avgvol20: 100 },
    session: { phase: "open", minutesSinceOpen: 30, sessionOpenTs: 1 },
    position: null,
    sentiment: 0,
    optionChain: chain,
  };
}

describe("Option Momentum + OI Confirmation Scalper", () => {
  it("waits for an option observation, then buys a CE after aligned momentum", () => {
    const state = indexOptionMomentumScalper.init(params, "NSE:NIFTY50-INDEX");
    const first = indexOptionMomentumScalper.analyze(
      context(60_000, 110, {
        callLtp: 100,
        callVolume: 100,
        callOI: 200,
        callChangeOI: 20,
      }),
      state,
    );
    expect(first.side).toBe("HOLD");

    const second = indexOptionMomentumScalper.analyze(
      context(120_000, 111, {
        callLtp: 101,
        callVolume: 120,
        callOI: 230,
        callChangeOI: 30,
      }),
      state,
    );
    expect(second.side).toBe("BUY");
    expect(second.reason).toContain("option-momentum-scalper.v1");
  });

  it("blocks a setup when the option spread is too wide", () => {
    const state = indexOptionMomentumScalper.init(params, "NSE:NIFTY50-INDEX");
    const first = context(60_000, 110, {
      callLtp: 100,
      callVolume: 100,
      callOI: 200,
      callChangeOI: 20,
    });
    first.optionChain!.rows[0]!.callBid = 90;
    first.optionChain!.rows[0]!.callAsk = 110;
    expect(indexOptionMomentumScalper.analyze(first, state).side).toBe("HOLD");

    const second = context(120_000, 111, {
      callLtp: 101,
      callVolume: 120,
      callOI: 230,
      callChangeOI: 30,
    });
    second.optionChain!.rows[0]!.callBid = 90;
    second.optionChain!.rows[0]!.callAsk = 110;
    expect(indexOptionMomentumScalper.analyze(second, state).side).toBe("HOLD");
  });
});
