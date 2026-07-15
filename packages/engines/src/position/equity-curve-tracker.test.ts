import { describe, expect, it } from "vitest";
import { EquityCurveTracker } from "./equity-curve-tracker.js";

/** Epoch ms for an IST wall-clock instant (month is 0-based). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const ist = (d: number, h: number, mi: number): number =>
  Date.UTC(2026, 0, d, h, mi) - IST_OFFSET_MS;

describe("EquityCurveTracker (plan/06 §4 day curve)", () => {
  it("records samples only while the market is open", () => {
    const tracker = new EquityCurveTracker();
    tracker.sample(ist(5, 8, 30), "closed", 0, 0);
    tracker.sample(ist(5, 9, 5), "pre-open", 0, 0);
    tracker.sample(ist(5, 9, 20), "open", -100, 40);
    tracker.sample(ist(5, 9, 21), "open", -120, 55);
    tracker.sample(ist(5, 15, 45), "closed", -120, 0);

    expect(tracker.points()).toEqual([
      { ts: ist(5, 9, 20), realizedPnl: -100, unrealizedPnl: 40 },
      { ts: ist(5, 9, 21), realizedPnl: -120, unrealizedPnl: 55 },
    ]);
  });

  it("clears the buffer when a new IST trading day begins", () => {
    const tracker = new EquityCurveTracker();
    tracker.sample(ist(5, 10, 0), "open", 500, 0);
    expect(tracker.points()).toHaveLength(1);

    // Next day's first sample (even a closed one) rolls the day over.
    tracker.sample(ist(6, 8, 0), "closed", 0, 0);
    expect(tracker.points()).toHaveLength(0);

    tracker.sample(ist(6, 9, 30), "open", 25, 0);
    expect(tracker.points()).toEqual([
      { ts: ist(6, 9, 30), realizedPnl: 25, unrealizedPnl: 0 },
    ]);
  });

  it("caps the buffer at maxPoints, keeping the newest", () => {
    const tracker = new EquityCurveTracker(3);
    for (let i = 0; i < 5; i++) {
      tracker.sample(ist(5, 10, i), "open", i, 0);
    }
    expect(tracker.points().map((p) => p.realizedPnl)).toEqual([2, 3, 4]);
  });
});
