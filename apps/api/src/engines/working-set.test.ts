import { describe, expect, it } from "vitest";
import { deriveWorkingSet } from "./runtime.js";

/**
 * The union of enabled strategies' symbols is what the market-data feed is
 * asked to stream. An empty working set means the socket connects and
 * subscribes to nothing — connected, healthy-looking, and completely silent.
 */
describe("deriveWorkingSet", () => {
  it("unions the symbols of every enabled strategy", () => {
    expect(
      deriveWorkingSet([
        { symbols: ["NSE:SBIN-EQ"] },
        { symbols: ["NSE:INFY-EQ", "NSE:TCS-EQ"] },
      ]),
    ).toEqual(["NSE:SBIN-EQ", "NSE:INFY-EQ", "NSE:TCS-EQ"]);
  });

  it("subscribes a shared symbol once, not once per strategy", () => {
    // Two strategies on one instrument is normal. A duplicate subscription
    // burns broker quota and duplicates every tick downstream.
    expect(
      deriveWorkingSet([
        { symbols: ["NSE:SBIN-EQ", "NSE:INFY-EQ"] },
        { symbols: ["NSE:SBIN-EQ"] },
      ]),
    ).toEqual(["NSE:SBIN-EQ", "NSE:INFY-EQ"]);
  });

  it("is empty when nothing is enabled", () => {
    // The state that produced 0 signals: the feed had nothing to ask for.
    expect(deriveWorkingSet([])).toEqual([]);
  });

  it("ignores a strategy that lists no symbols", () => {
    expect(
      deriveWorkingSet([{ symbols: [] }, { symbols: ["NSE:SBIN-EQ"] }]),
    ).toEqual(["NSE:SBIN-EQ"]);
  });

  it("accepts a Map's values, which is how the runtime holds them", () => {
    const enabled = new Map([
      ["str_1", { symbols: ["NSE:SBIN-EQ"] }],
      ["str_2", { symbols: ["NSE:TCS-EQ"] }],
    ]);
    expect(deriveWorkingSet(enabled.values())).toEqual([
      "NSE:SBIN-EQ",
      "NSE:TCS-EQ",
    ]);
  });
});
