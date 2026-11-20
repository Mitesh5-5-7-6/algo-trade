import { describe, expect, it } from "vitest";
import type { Trade, TradeCard } from "@neelkanth/core";
import { cardLive, type LivePosition } from "./card-status.js";

/** 2026-11-20 12:30 IST. */
const NOW = Date.UTC(2026, 10, 20, 7, 0);

const card = { signalId: "sig_1", strategyId: "str_mom" } as TradeCard;

const trade = (over: Partial<Trade> = {}): Trade =>
  ({
    tradeId: "trd_1",
    strategyId: "str_mom",
    symbol: "NSE:BANKNIFTY26NOV62500CE",
    side: "LONG",
    status: "OPEN",
    entrySignalId: "sig_1",
    entryPrice: 414.81,
    quantity: 150,
    entryTime: NOW - 86_400_000,
    ...over,
  }) as Trade;

const position = (over: Partial<LivePosition> = {}): LivePosition => ({
  positionId: "pos_1",
  symbol: "NSE:BANKNIFTY26NOV62500CE",
  strategyId: "str_mom",
  side: "LONG",
  qty: 150,
  avgEntryPrice: 414.81,
  status: "OPEN",
  realizedPnl: 0,
  unrealizedPnl: 0,
  stopLoss: 321.56,
  target: 680.21,
  openedAt: NOW - 86_400_000,
  mode: "paper",
  ...over,
});

describe("what became of a trade card (2026-11-20)", () => {
  it("shows an open position with its live price and P&L", () => {
    expect(
      cardLive({
        card,
        trade: trade(),
        position: position({ ltp: 500, ltpAt: NOW - 5_000 }),
        now: NOW,
        marketOpen: true,
      }),
    ).toEqual({
      state: "OPEN",
      symbol: "NSE:BANKNIFTY26NOV62500CE",
      qty: 150,
      avgEntryPrice: 414.81,
      ltp: 500,
      ltpAt: NOW - 5_000,
      unrealizedPnl: (500 - 414.81) * 150,
      stopLoss: 321.56,
      target: 680.21,
      stale: false,
    });
  });

  it("flags a price that stopped arriving — the bug of 2026-11-19 — but not after the close", () => {
    const silent = position({ ltp: 498, ltpAt: NOW - 22 * 3_600_000 });
    expect(
      cardLive({
        card,
        trade: trade(),
        position: silent,
        now: NOW,
        marketOpen: true,
      }),
    ).toMatchObject({ state: "OPEN", stale: true });
    expect(
      cardLive({
        card,
        trade: trade(),
        position: position(),
        now: NOW,
        marketOpen: true,
      }),
    ).toMatchObject({
      state: "OPEN",
      ltp: null,
      unrealizedPnl: null,
      stale: true,
    });
    expect(
      cardLive({
        card,
        trade: trade(),
        position: silent,
        now: NOW,
        marketOpen: false,
      }),
    ).toMatchObject({ stale: false });
  });

  it("shows how a closed trade ended", () => {
    expect(
      cardLive({
        card,
        trade: trade({
          status: "CLOSED",
          exitPrice: 174.66,
          exitReason: "TAKE_PROFIT",
          exitTime: NOW,
          netPnl: 4092,
        }),
        position: null,
        now: NOW,
        marketOpen: true,
      }),
    ).toEqual({
      state: "CLOSED",
      symbol: "NSE:BANKNIFTY26NOV62500CE",
      exitPrice: 174.66,
      exitReason: "TAKE_PROFIT",
      exitTime: NOW,
      netPnl: 4092,
    });
  });

  it("says when the entry was never filled", () => {
    expect(
      cardLive({
        card,
        trade: null,
        position: null,
        now: NOW,
        marketOpen: true,
      }),
    ).toEqual({ state: "NOT_FILLED" });
  });
});
