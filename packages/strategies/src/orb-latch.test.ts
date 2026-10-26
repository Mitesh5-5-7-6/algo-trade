import { describe, expect, it } from "vitest";
import type { Candle, MarketContext } from "@neelkanth/core";
import { orb, type OrbParams, type OrbState } from "./orb.js";
import type { SignalResolution } from "./contract.js";

/**
 * §0.5.5 — the one-shot latch must be spent by a FILL, not by an emission.
 *
 * The bug: `analyze()` set `enteredUp = true` the moment it proposed. If the
 * Risk Engine then blocked the signal, ORB's single daily entry was gone and
 * the strategy stayed silent until the close — indistinguishable, from the
 * outside, from a day on which no breakout ever happened.
 */

const SESSION_OPEN = Date.UTC(2026, 0, 5, 3, 45); // 09:15 IST
const BAR_MS = 300_000;

const params = (overrides: Partial<OrbParams> = {}): OrbParams =>
  orb.paramsSchema.parse({ rangeMinutes: 15, ...overrides });

const bar = (index: number, fields: Partial<Candle> = {}): Candle => ({
  symbol: "NSE:ORB-EQ",
  interval: "5m",
  source: "LIVE_TICK",
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1_000,
  ts: SESSION_OPEN + index * BAR_MS,
  ...fields,
});

/** Bars 0–2 form a 100–90 range; anything after can break it. */
const RANGE = [
  bar(0, { high: 99, low: 91 }),
  bar(1, { high: 100, low: 90 }),
  bar(2, { high: 98, low: 92 }),
];

function context(candles: Candle[]): MarketContext {
  const candle = candles.at(-1);
  if (candle === undefined) throw new Error("need a bar");
  return {
    symbol: "NSE:ORB-EQ",
    interval: "5m",
    candle,
    candles,
    indicators: {},
    session: {
      phase: "open",
      minutesSinceOpen: (candle.ts - SESSION_OPEN) / 60_000 + 5,
      sessionOpenTs: SESSION_OPEN,
    },
    position: null,
    sentiment: 0,
  };
}

/** Feed the range plus one breakout bar, and return the verdict on it. */
function runThrough(state: OrbState, candles: Candle[]) {
  let verdict = orb.analyze(context([candles[0] as Candle]), state);
  for (let i = 1; i < candles.length; i += 1) {
    verdict = orb.analyze(context(candles.slice(0, i + 1)), state);
  }
  return verdict;
}

const rejection = (side: "BUY" | "SELL"): SignalResolution => ({
  signalId: "sig_1",
  side,
  status: "REJECTED",
  reason: "risk blocked: marketBias",
});

const fill = (side: "BUY" | "SELL"): SignalResolution => ({
  signalId: "sig_1",
  side,
  status: "FILLED",
  reason: "filled 10 @ 101",
});

describe("ORB one-shot latch", () => {
  it("proposes an entry on the breakout bar", () => {
    const state = orb.init(params(), "NSE:ORB-EQ");
    const verdict = runThrough(state, [...RANGE, bar(3, { close: 101 })]);

    expect(verdict.side).toBe("BUY");
    // Proposed, not taken — nothing has confirmed it yet.
    expect(state.upEntry).toBe("proposed");
  });

  /** Otherwise it re-proposes on every bar while the first order is in flight. */
  it("does not propose again while the first proposal is unresolved", () => {
    const state = orb.init(params(), "NSE:ORB-EQ");
    runThrough(state, [...RANGE, bar(3, { close: 101 })]);

    const second = orb.analyze(
      context([...RANGE, bar(3, { close: 101 }), bar(4, { close: 102 })]),
      state,
    );
    expect(second.side).toBe("HOLD");
    expect(state.upEntry).toBe("proposed");
  });

  /**
   * The failure this closes. A block at 09:30 must not cost the 09:35 entry.
   */
  it("releases the latch when risk blocks the signal, and enters later", () => {
    const state = orb.init(params(), "NSE:ORB-EQ");
    runThrough(state, [...RANGE, bar(3, { close: 101 })]);

    orb.onSignalOutcome?.(state, rejection("BUY"));
    expect(state.upEntry).toBe("none");

    const retry = orb.analyze(
      context([...RANGE, bar(3, { close: 101 }), bar(4, { close: 103 })]),
      state,
    );
    expect(retry.side).toBe("BUY");
    expect(state.upEntry).toBe("proposed");
  });

  it("spends the day's entry only on a confirmed fill", () => {
    const state = orb.init(params(), "NSE:ORB-EQ");
    runThrough(state, [...RANGE, bar(3, { close: 101 })]);

    orb.onSignalOutcome?.(state, fill("BUY"));
    expect(state.upEntry).toBe("entered");

    const after = orb.analyze(
      context([...RANGE, bar(3, { close: 101 }), bar(4, { close: 105 })]),
      state,
    );
    expect(after.side).toBe("HOLD");
    expect(state.upEntry).toBe("entered");
  });

  /**
   * A duplicate or late resolution must not reopen an entry that is already
   * real — that would be the double-entry this latch exists to prevent.
   */
  it("ignores a rejection that arrives after the entry was confirmed", () => {
    const state = orb.init(params(), "NSE:ORB-EQ");
    runThrough(state, [...RANGE, bar(3, { close: 101 })]);
    orb.onSignalOutcome?.(state, fill("BUY"));
    orb.onSignalOutcome?.(state, rejection("BUY"));

    expect(state.upEntry).toBe("entered");
  });

  it("ignores a resolution for a side it never proposed", () => {
    const state = orb.init(params({ allowShort: true }), "NSE:ORB-EQ");
    runThrough(state, [...RANGE, bar(3, { close: 101 })]);

    orb.onSignalOutcome?.(state, fill("SELL"));
    expect(state.downEntry).toBe("none");
    expect(state.upEntry).toBe("proposed");
  });

  it("keeps the long and short latches independent", () => {
    const state = orb.init(params({ allowShort: true }), "NSE:ORB-EQ");
    runThrough(state, [...RANGE, bar(3, { close: 101 })]);
    orb.onSignalOutcome?.(state, fill("BUY"));

    // A break of the LOW is still available, its own latch untouched.
    const short = orb.analyze(
      context([...RANGE, bar(3, { close: 101 }), bar(4, { close: 89 })]),
      state,
    );
    expect(short.side).toBe("SELL");
    expect(state.downEntry).toBe("proposed");
    expect(state.upEntry).toBe("entered");
  });

  /**
   * A proposal whose verdict never arrives stays proposed for the session.
   * That is the conservative direction: a trade not taken costs an
   * opportunity, a trade taken twice costs money.
   */
  it("holds an unresolved proposal rather than retrying blindly", () => {
    const state = orb.init(params(), "NSE:ORB-EQ");
    runThrough(state, [...RANGE, bar(3, { close: 101 })]);

    for (let i = 4; i < 12; i += 1) {
      const verdict = orb.analyze(
        context([...RANGE, bar(3, { close: 101 }), bar(i, { close: 100 + i })]),
        state,
      );
      expect(verdict.side).toBe("HOLD");
    }
    expect(state.upEntry).toBe("proposed");
  });

  it("clears both latches at the next session", () => {
    const state = orb.init(params(), "NSE:ORB-EQ");
    runThrough(state, [...RANGE, bar(3, { close: 101 })]);
    orb.onSignalOutcome?.(state, fill("BUY"));
    expect(state.upEntry).toBe("entered");

    // A new session anchor is what resets it — not a clock heuristic, so a
    // restart within a session resumes it rather than declaring a new one.
    const tomorrow = context([bar(0, { high: 99, low: 91 })]);
    const nextDay: MarketContext = {
      ...tomorrow,
      session: {
        ...tomorrow.session,
        sessionOpenTs: SESSION_OPEN + 86_400_000,
      },
    };
    orb.analyze(nextDay, state);
    expect(state.upEntry).toBe("none");
    expect(state.downEntry).toBe("none");
  });
});
