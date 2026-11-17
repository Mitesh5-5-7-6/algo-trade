import { describe, expect, it } from "vitest";
import { barDate, describeHeld, describeReason, parseScanForm } from "./scan";

describe("the scan form", () => {
  it("sends the day and the minimum days to expiry", () => {
    expect(parseScanForm({ date: "2026-11-17", minDaysToExpiry: "2" })).toEqual(
      {
        ok: true,
        request: { date: "2026-11-17", minDaysToExpiry: 2 },
      },
    );
  });

  it("refuses a missing day and an expiry outside 0 to 30 whole days", () => {
    expect(parseScanForm({ date: "", minDaysToExpiry: "2" })).toMatchObject({
      ok: false,
    });
    for (const minDaysToExpiry of ["", "-1", "31", "1.5", "x"])
      expect(
        parseScanForm({ date: "2026-11-17", minDaysToExpiry }),
        minDaysToExpiry,
      ).toEqual({
        ok: false,
        error: "Minimum days to expiry is a whole number from 0 to 30.",
      });
  });
});

describe("the scan in words", () => {
  it("says what held, with the evidence that decided it", () => {
    expect(
      describeHeld({
        patternId: "HIGH_VOLUME_BREAKOUT",
        detectorVersion: "1.0.0",
        direction: "BULLISH",
        evidence: {
          close: 1345.3,
          priorHigh: 1340,
          priorLow: 1290,
          volume: 15_000_000,
          averageVolume: 6_000_000,
        },
      }),
    ).toBe(
      "Volume breakout, bullish: close 1345 past 1340, volume 2.5× of average",
    );
    expect(
      describeHeld({
        patternId: "HIGH_VOLUME_BREAKOUT",
        detectorVersion: "1.0.0",
        direction: "BEARISH",
        evidence: {
          close: 95,
          priorHigh: 110,
          priorLow: 98,
          volume: 3,
          averageVolume: 1,
        },
      }),
    ).toBe(
      "Volume breakout, bearish: close 95.00 past 98.00, volume 3.0× of average",
    );
    expect(
      describeHeld({
        patternId: "RSI_REVERSION",
        detectorVersion: "1.0.0",
        direction: "BULLISH",
        evidence: { rsi: 33.2, prev: 28.9, oversold: 30, overbought: 70 },
      }),
    ).toBe("RSI reversion, bullish: RSI 28.90 → 33.20");
    expect(
      describeHeld({
        patternId: "SOMETHING_NEW",
        detectorVersion: "1",
        direction: "NEUTRAL",
        evidence: {},
      }),
    ).toBe("SOMETHING_NEW, neutral");
  });

  it("names each rejection and dates each bar in IST", () => {
    expect(describeReason("STALE_DATA")).toBe("Data not current");
    expect(describeReason("NO_BARS")).toBe("No daily bars");
    // FYERS's stamp for a daily bar: 00:00 UTC, 05:30 IST, same date.
    expect(barDate(Date.UTC(2026, 10, 16))).toBe("2026-11-16");
    expect(barDate(null)).toBe("—");
  });
});
