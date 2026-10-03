import { describe, expect, it } from "vitest";
import type { StrategyConfig } from "./strategy.js";
import { strategyVersionOf } from "./strategy-version.js";

/**
 * Task 2.8 — every strategy is versioned (PLAN.md rule 9).
 *
 * `strategyVersion` reached Signal, Order and Trade, but nothing ever set it
 * on a config: neither the create nor the update route accepts it. So every
 * decision was unversioned. A version is now derived from what decides —
 * type, params, risk rules — whenever none is declared.
 */
const config = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  strategyId: "str_1",
  ownerId: "usr_1",
  type: "ORB",
  name: "Morning breakout",
  params: { rangeMinutes: 15, targetR: 2 },
  symbols: ["NSE:NIFTY50-INDEX"],
  riskRules: { maxPositionSize: 50 },
  enabled: true,
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("strategyVersionOf (§2.8, PLAN rule 9)", () => {
  it("keeps a version an operator declared", () => {
    expect(strategyVersionOf(config({ strategyVersion: "v3" }))).toBe("v3");
  });

  it("derives a labelled version when none is declared", () => {
    expect(strategyVersionOf(config())).toMatch(/^cfg-[0-9a-f]{14}$/);
  });

  /** Same rule, same version — whichever order the params were written in. */
  it("is stable across key order", () => {
    expect(
      strategyVersionOf(config({ params: { targetR: 2, rangeMinutes: 15 } })),
    ).toBe(strategyVersionOf(config()));
  });

  it.each([
    ["a param", { params: { rangeMinutes: 30, targetR: 2 } }],
    ["the risk rules", { riskRules: { maxPositionSize: 10 } }],
    ["the strategy type", { type: "EMA_CROSSOVER" }],
  ])("changes when %s changes", (_what, over) => {
    expect(strategyVersionOf(config(over))).not.toBe(
      strategyVersionOf(config()),
    );
  });

  /**
   * Not a different strategy. A rename, a timestamp, or a symbol added to the
   * list changes nothing about how any one instance decides.
   */
  it.each([
    ["the name", { name: "Renamed" }],
    ["the symbols", { symbols: ["NSE:NIFTYBANK-INDEX", "NSE:NIFTY50-INDEX"] }],
    ["enablement", { enabled: false }],
    ["the timestamps", { createdAt: 99, updatedAt: 99 }],
  ])("ignores %s", (_what, over) => {
    expect(strategyVersionOf(config(over))).toBe(strategyVersionOf(config()));
  });
});
