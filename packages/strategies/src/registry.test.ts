import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { MarketContext, StrategyVerdict } from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { StrategyRegistry } from "./registry.js";

const ParamsSchema = z.object({ threshold: z.number() });
type Params = z.infer<typeof ParamsSchema>;
interface State {
  symbol: string;
}

const fakeDef: StrategyDefinition<Params, State> = {
  type: "FAKE",
  paramsSchema: ParamsSchema,
  interval: () => "5m",
  requiredIndicators: () => [{ kind: "ema", period: 9 }],
  warmupBars: () => 9,
  init: (_params, symbol) => ({ symbol }),
  analyze: (context: MarketContext, state: State): StrategyVerdict =>
    context.candle.close >= 100
      ? { side: "BUY", confidence: 1, reason: `${state.symbol} over 100` }
      : { side: "HOLD", confidence: 0, reason: "under" },
};

describe("StrategyRegistry (plan/15 §4)", () => {
  it("instantiates a registered strategy and validates its params", () => {
    const registry = new StrategyRegistry();
    registry.register(fakeDef);
    expect(registry.has("FAKE")).toBe(true);

    const instance = registry.instantiate("FAKE", { threshold: 5 }, "NSE:X-EQ");
    expect(instance.type).toBe("FAKE");
    expect(instance.interval).toBe("5m");
    expect(instance.requiredIndicators()).toEqual([{ kind: "ema", period: 9 }]);
  });

  it("rejects invalid params at instantiation (plan/15 §4 boundary)", () => {
    const registry = new StrategyRegistry();
    registry.register(fakeDef);
    expect(() =>
      registry.instantiate("FAKE", { threshold: "nope" }, "NSE:X-EQ"),
    ).toThrow();
  });

  it("fails loudly on an unknown type", () => {
    const registry = new StrategyRegistry();
    expect(() => registry.instantiate("GHOST", {}, "NSE:X-EQ")).toThrow(
      /unknown strategy type/,
    );
  });

  it("refuses a duplicate registration", () => {
    const registry = new StrategyRegistry();
    registry.register(fakeDef);
    expect(() => {
      registry.register(fakeDef);
    }).toThrow(/already registered/);
  });

  it("gives each symbol its own private state instance (plan/15 §7)", () => {
    const registry = new StrategyRegistry();
    registry.register(fakeDef);
    const a = registry.instantiate("FAKE", { threshold: 1 }, "NSE:A-EQ");
    const b = registry.instantiate("FAKE", { threshold: 1 }, "NSE:B-EQ");
    expect(a).not.toBe(b);
  });
});
