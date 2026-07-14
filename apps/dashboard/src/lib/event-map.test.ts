import { describe, expect, it } from "vitest";
import { FORWARDED_EVENTS, queryKeysForEvent } from "./event-map";
import { qk } from "./query-keys";

describe("queryKeysForEvent (plan/06 §5 socket→cache reconciliation)", () => {
  it("a fill invalidates orders, positions, and pnl", () => {
    expect(queryKeysForEvent("ORDER_FILLED")).toEqual([
      qk.orders,
      qk.positions,
      qk.pnl,
    ]);
  });

  it("a position update invalidates positions and pnl", () => {
    expect(queryKeysForEvent("POSITION_UPDATED")).toEqual([
      qk.positions,
      qk.pnl,
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

  it("activity-only events invalidate nothing (no cached read model yet)", () => {
    expect(queryKeysForEvent("SIGNAL_CREATED")).toEqual([]);
    expect(queryKeysForEvent("SYSTEM_ERROR")).toEqual([]);
  });

  it("every forwarded event is handled", () => {
    for (const event of FORWARDED_EVENTS) {
      expect(() => queryKeysForEvent(event)).not.toThrow();
    }
  });
});
