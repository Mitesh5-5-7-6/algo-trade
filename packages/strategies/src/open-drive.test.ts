import { describe, expect, it } from "vitest";
import type { Candle, MarketContext } from "@neelkanth/core";
import { openDrive, OpenDriveParamsSchema } from "./open-drive.js";

/** 2026-11-20 09:15 IST — the session open. */
const OPEN_TS = Date.UTC(2026, 10, 20, 3, 45);
const FIVE = 5 * 60_000;

/** Bars from the open: [open, high, low, close] each. */
function bars(rows: [number, number, number, number][]): Candle[] {
  return rows.map(([open, high, low, close], i) => ({
    symbol: "NSE:NIFTY50-INDEX",
    interval: "5m" as const,
    source: "LIVE_TICK" as const,
    open,
    high,
    low,
    close,
    volume: 0,
    ts: OPEN_TS + i * FIVE,
  }));
}

function context(candles: Candle[]): MarketContext {
  const candle = candles.at(-1);
  if (candle === undefined) throw new Error("fixture built no bars");
  return {
    symbol: "NSE:NIFTY50-INDEX",
    interval: "5m",
    candle,
    candles,
    indicators: {},
    session: {
      phase: "open",
      minutesSinceOpen: Math.round((candle.ts + FIVE - OPEN_TS) / 60_000),
      sessionOpenTs: OPEN_TS,
    },
    position: null,
    sentiment: 0,
  };
}

const fresh = () =>
  openDrive.init(OpenDriveParamsSchema.parse({}), "NSE:NIFTY50-INDEX");

/** Six bars to 09:45: an open at 25,368 driving up 0.6% without looking back. */
const driveUp: [number, number, number, number][] = [
  [25_368, 25_420, 25_360, 25_410],
  [25_410, 25_450, 25_400, 25_440],
  [25_440, 25_470, 25_430, 25_460],
  [25_460, 25_490, 25_450, 25_480],
  [25_480, 25_510, 25_470, 25_500],
  [25_500, 25_530, 25_490, 25_525],
];

describe("open-drive (14.24)", () => {
  it("buys a call when the index drives 0.5%+ up and never looks back by 09:45", () => {
    const verdict = openDrive.analyze(context(bars(driveUp)), fresh());
    expect(verdict.side).toBe("BUY");
    expect(verdict.stopLossPct).toBe(0.3);
    expect(verdict.reason).toContain("open-drive up");
  });

  it("buys a put on the mirror image", () => {
    const down = driveUp.map(
      ([o, h, l, c]) =>
        [50_736 - o, 50_736 - l, 50_736 - h, 50_736 - c] as [
          number,
          number,
          number,
          number,
        ],
    );
    expect(openDrive.analyze(context(bars(down)), fresh()).side).toBe("SELL");
  });

  it("holds when the index came back below the open first", () => {
    const dipped = driveUp.map((r) => [...r] as [number, number, number, number]);
    dipped[2] = [25_440, 25_470, 25_300, 25_460]; // a low well under the open
    expect(openDrive.analyze(context(bars(dipped)), fresh()).side).toBe("HOLD");
  });

  it("holds when the move is too small", () => {
    const small = driveUp.map(
      ([o, h, l, c]) =>
        [o, 25_368 + (h - 25_368) / 4, Math.max(l, 25_366), 25_368 + (c - 25_368) / 4] as [
          number,
          number,
          number,
          number,
        ],
    );
    expect(openDrive.analyze(context(bars(small)), fresh()).side).toBe("HOLD");
  });

  it("decides only at the judging bar, once a day", () => {
    const state = fresh();
    expect(openDrive.analyze(context(bars(driveUp.slice(0, 5))), state).side).toBe("HOLD"); // 09:40
    expect(openDrive.analyze(context(bars(driveUp)), state).side).toBe("BUY"); // 09:45
    const later = [...driveUp, [25_525, 25_560, 25_520, 25_555] as [number, number, number, number]];
    expect(openDrive.analyze(context(bars(later)), state).side).toBe("HOLD"); // 09:50
  });

  it("buys one strike in the money, at least 5 days from expiry", () => {
    expect(openDrive.derivative?.(OpenDriveParamsSchema.parse({}))).toEqual({
      underlying: "NIFTY",
      kind: "OPTION",
      strikeOffset: -1,
      minDaysToExpiry: 5,
    });
  });
});
