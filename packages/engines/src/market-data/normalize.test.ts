import { describe, expect, it } from "vitest";
import { fixtureNormalizer } from "./normalize.js";

describe("fixtureNormalizer (plan/17 §2 normalization boundary)", () => {
  it("maps broker-ish raw fields to an internal Tick and drops extras", () => {
    const tick = fixtureNormalizer({
      sym: "NSE:INFY-EQ",
      ltp: 1500.5,
      vol: 40,
      bid: 1500.4,
      ask: 1500.6,
      ts: 1_730_000_000_000,
      exchange_junk_field: "ignored",
    });
    expect(tick).toEqual({
      symbol: "NSE:INFY-EQ",
      ltp: 1500.5,
      volume: 40,
      bid: 1500.4,
      ask: 1500.6,
      ts: 1_730_000_000_000,
    });
  });

  it("returns null for a structurally invalid message", () => {
    expect(fixtureNormalizer({ nope: true })).toBeNull();
    expect(fixtureNormalizer(null)).toBeNull();
    expect(fixtureNormalizer("tick")).toBeNull();
  });

  it("drops a non-positive price rather than emitting a bad tick (plan/17 §8)", () => {
    expect(
      fixtureNormalizer({ sym: "NSE:INFY-EQ", ltp: 0, vol: 1, ts: 1 }),
    ).toBeNull();
    expect(
      fixtureNormalizer({ sym: "NSE:INFY-EQ", ltp: -5, vol: 1, ts: 1 }),
    ).toBeNull();
  });

  it("omits absent optional fields rather than nulling them", () => {
    const tick = fixtureNormalizer({
      sym: "NSE:TCS-EQ",
      ltp: 3900,
      vol: 2,
      ts: 10,
    });
    expect(tick).toEqual({
      symbol: "NSE:TCS-EQ",
      ltp: 3900,
      volume: 2,
      ts: 10,
    });
    expect(tick && "bid" in tick).toBe(false);
  });
});
