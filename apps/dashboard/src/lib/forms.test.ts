import { describe, expect, it } from "vitest";
import { parseParams, parseSymbols } from "./forms";

describe("parseSymbols", () => {
  it("splits on commas/whitespace, trims, and uppercases", () => {
    expect(parseSymbols("nse:infy-eq, NSE:TCS-EQ  nse:sbin-eq")).toEqual([
      "NSE:INFY-EQ",
      "NSE:TCS-EQ",
      "NSE:SBIN-EQ",
    ]);
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(parseSymbols("")).toBeNull();
    expect(parseSymbols("  , ,  ")).toBeNull();
  });
});

describe("parseParams", () => {
  it("accepts a JSON object", () => {
    expect(parseParams('{"fast": 9, "slow": 21}')).toEqual({
      fast: 9,
      slow: 21,
    });
  });

  it("rejects arrays, primitives, null, and broken JSON", () => {
    expect(parseParams("[1, 2]")).toBeNull();
    expect(parseParams('"x"')).toBeNull();
    expect(parseParams("null")).toBeNull();
    expect(parseParams("{fast: 9}")).toBeNull();
  });
});
