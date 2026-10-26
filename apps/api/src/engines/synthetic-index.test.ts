import { describe, expect, it } from "vitest";
import type { Instrument } from "@neelkanth/core";
import { instrumentLookup } from "./synthetic-index.js";

/**
 * Task 14.6 (design D1): FYERS lists the indices with lot size 0, so the
 * symbol master holds none, and risk refused every entry on the subject. In
 * paper an index is the replay's synthetic instrument; in live, never.
 */
const FUTURE: Instrument = {
  symbol: "NSE:NIFTY26NOVFUT",
  kind: "FUTURE",
  lotSize: 75,
  tickSize: 0.05,
};
const master = (symbol: string): Instrument | null =>
  symbol === FUTURE.symbol ? FUTURE : null;

describe("the instrument risk sizes against (§14.6, D1)", () => {
  it("gives a paper index the replay's synthetic instrument: lot 1, in points", () => {
    expect(instrumentLookup("paper", master)("NSE:NIFTY50-INDEX")).toEqual({
      symbol: "NSE:NIFTY50-INDEX",
      kind: "EQUITY",
      lotSize: 1,
      tickSize: 0.05,
    });
  });

  it("never invents one in live, where no index contract exists", () => {
    expect(instrumentLookup("live", master)("NSE:NIFTY50-INDEX")).toBeNull();
  });

  it("leaves everything else to the symbol master, in either mode", () => {
    for (const mode of ["paper", "live"] as const) {
      const lookup = instrumentLookup(mode, master);
      expect(lookup(FUTURE.symbol)).toBe(FUTURE);
      expect(lookup("NSE:UNLISTED-EQ")).toBeNull();
    }
  });
});
