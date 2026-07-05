import { describe, expect, it } from "vitest";
import {
  OrderSchema,
  PositionSchema,
  StrategyConfigSchema,
} from "@neelkanth/core";
import { getMockSnapshot } from "./data.js";

/**
 * The mock seam must speak the REAL domain shapes — otherwise swapping in
 * live data at milestone 1.9 would break components the mocks had quietly
 * trained on wrong shapes. Every fixture is validated against `core`.
 */
describe("mock snapshot conforms to core schemas", () => {
  const snapshot = getMockSnapshot();

  it("positions parse as core Positions", () => {
    for (const position of snapshot.positions) {
      const result = PositionSchema.safeParse(position);
      expect(result.success, JSON.stringify(result)).toBe(true);
    }
  });

  it("orders parse as core Orders", () => {
    for (const order of snapshot.orders) {
      const result = OrderSchema.safeParse(order);
      expect(result.success, JSON.stringify(result)).toBe(true);
    }
  });

  it("strategy configs parse as core StrategyConfigs", () => {
    for (const row of snapshot.strategies) {
      const result = StrategyConfigSchema.safeParse(row.config);
      expect(result.success, JSON.stringify(result)).toBe(true);
    }
  });

  it("reproduces the design reference frame (plan/06 §4)", () => {
    expect(snapshot.dayPnl.realized + snapshot.dayPnl.unrealized).toBe(-18_683);
    expect(snapshot.dayPnl.lossLimitUsed).toBe(0.82);
    expect(snapshot.dayPnl.lossLimit).toBe(25_000);
    expect(snapshot.status.engine.signalsToday).toBe(26);
    expect(snapshot.settings.capitalAllocation).toBe(600_000);
    expect(snapshot.settings.squareOffTime).toBe("15:12");
  });

  it("curve ends at the design's day P&L and stays above the loss limit", () => {
    const values = snapshot.dayPnl.curve.map((point) => point.value);
    expect(values[values.length - 1]).toBe(-18_683);
    for (const value of values) {
      expect(value).toBeGreaterThan(-snapshot.dayPnl.lossLimit);
    }
  });
});
