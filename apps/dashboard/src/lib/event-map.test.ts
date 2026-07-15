import { describe, expect, it } from "vitest";
import { FORWARDED_EVENTS, queryKeysForEvent } from "./event-map";
import { qk } from "./query-keys";

describe("queryKeysForEvent (plan/06 §5 socket→cache reconciliation)", () => {
  it("a fill invalidates orders, positions, pnl, activity, and day stats", () => {
    expect(queryKeysForEvent("ORDER_FILLED")).toEqual([
      qk.orders,
      qk.positions,
      qk.pnl,
      qk.activity,
      qk.strategyStats,
    ]);
  });

  it("a position update invalidates positions, pnl, and day stats", () => {
    expect(queryKeysForEvent("POSITION_UPDATED")).toEqual([
      qk.positions,
      qk.pnl,
      qk.strategyStats,
    ]);
  });

  it("pnl invalidates only pnl", () => {
    expect(queryKeysForEvent("PNL_UPDATED")).toEqual([qk.pnl]);
  });

  it("broker/market status invalidates the control status", () => {
    expect(queryKeysForEvent("BROKER_DISCONNECTED")).toEqual([
      qk.controlStatus,
    ]);
    expect(queryKeysForEvent("MARKET_OPEN")).toEqual([qk.controlStatus]);
  });

  it("a signal invalidates the activity feed and day stats", () => {
    expect(queryKeysForEvent("SIGNAL_CREATED")).toEqual([
      qk.activity,
      qk.strategyStats,
    ]);
  });

  it("a risk block invalidates only the activity feed (its signal was already counted)", () => {
    expect(queryKeysForEvent("RISK_BLOCKED")).toEqual([qk.activity]);
  });

  it("a system error invalidates nothing (surfaced as an alert)", () => {
    expect(queryKeysForEvent("SYSTEM_ERROR")).toEqual([]);
  });

  it("every forwarded event is handled", () => {
    for (const event of FORWARDED_EVENTS) {
      expect(() => queryKeysForEvent(event)).not.toThrow();
    }
  });
});
