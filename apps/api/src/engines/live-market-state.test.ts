import { describe, expect, it } from "vitest";
import { createLiveMarketState } from "./live-market-state.js";

describe("createLiveMarketState", () => {
  it("tracks option-chain snapshots for chain-dependent strategies", () => {
    const state = createLiveMarketState();

    expect(state.optionChains).toBeInstanceOf(Map);

    state.optionChains.set("NIFTY", {
      underlying: "NIFTY",
      expiry: Date.now() + 86_400_000,
      asOf: Date.now(),
      spot: 24_400,
      rows: [
        {
          strike: 24_400,
          callOI: 1000,
          putOI: 900,
          callChangeOI: 20,
          putChangeOI: -10,
        },
      ],
    });

    expect(state.optionChains.get("NIFTY")?.underlying).toBe("NIFTY");
  });
});
