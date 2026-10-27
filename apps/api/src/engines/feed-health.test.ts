import { describe, expect, it } from "vitest";
import { FEED_SILENCE_MS, feedSilentSeconds } from "./feed-health.js";

/** A connected feed that delivers nothing must not read as a live one. */
const NOW = 1_800_000_000_000;
const feed = (over: Partial<Parameters<typeof feedSilentSeconds>[0]> = {}) =>
  feedSilentSeconds({
    connected: true,
    marketOpen: true,
    since: NOW - 10 * 60_000,
    lastTickAt: 0,
    now: NOW,
    ...over,
  });

describe("feed silence", () => {
  it("names a connected feed that has had no tick since it connected", () => {
    expect(feed()).toBe(600);
  });

  it("names one whose ticks stopped", () => {
    expect(feed({ lastTickAt: NOW - 120_000 })).toBe(120);
  });

  it("is quiet while ticks arrive, and for a fresh connection's first minute", () => {
    expect(feed({ lastTickAt: NOW - 5_000 })).toBeNull();
    expect(feed({ since: NOW - FEED_SILENCE_MS })).toBeNull();
  });

  it("asks nothing of a feed that is down or a market that is shut", () => {
    expect(feed({ connected: false })).toBeNull();
    expect(feed({ marketOpen: false })).toBeNull();
  });
});
