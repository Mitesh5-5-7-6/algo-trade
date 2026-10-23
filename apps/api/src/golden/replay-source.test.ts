import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import {
  runGoldenPipeline,
  runReplay,
  type GoldenRecord,
  type ReplayInput,
} from "./pipeline.js";
import { goldenFixture } from "./fixture.js";
import { sessionsFromCandles } from "../replay/sessions.js";

/**
 * Task 4.4 — one pipeline, two sources (design D1), across days (D6).
 *
 * A historical replay is fed the broker's stored bars, not ticks. These prove
 * the stored-bar door leads into the SAME machine as the feed: given the bars
 * the feed itself produced, it decides the same things.
 */

/** The golden day, run from ticks at 5m only, with every closed bar captured. */
async function feedBars(): Promise<{ record: GoldenRecord; bars: Candle[] }> {
  const fixture = goldenFixture();
  const bars: Candle[] = [];
  const record = await runReplay({
    ...asInput(fixture),
    intervals: ["5m"],
    onCandleClosed: (candle) => bars.push(candle),
  });
  return { record, bars };
}

/** The golden fixture as a replay input, ticks and all. */
function asInput(fixture: ReturnType<typeof goldenFixture>): ReplayInput {
  return {
    interval: fixture.interval,
    intervals: fixture.intervals,
    source: { kind: "ticks", ticks: fixture.ticks },
    sessions: [
      {
        date: "2026-01-05",
        preOpenTs: fixture.preOpenTs,
        sessionOpenTs: fixture.sessionOpenTs,
        squareOffTs: fixture.squareOffTs,
        afterCloseTs: fixture.afterCloseTs,
      },
    ],
    strategies: fixture.strategies,
    indexSymbols: fixture.indexSymbols,
    breadthSymbols: fixture.breadthSymbols,
    ...(fixture.biasConfig === undefined
      ? {}
      : { biasConfig: fixture.biasConfig }),
    allocatedCapital: fixture.allocatedCapital,
    limits: fixture.limits,
  };
}

describe("one pipeline, two sources (§4.4, D1)", () => {
  it("the golden wrapper is a one-session tick replay", async () => {
    const fixture = goldenFixture();
    expect(await runReplay(asInput(fixture))).toEqual(
      await runGoldenPipeline(fixture),
    );
  });

  /**
   * The stored-bar door leads into the same machine. Fed the bars the feed
   * produced, a candle run reaches the same decisions, orders and Trades —
   * once the bars the feed could only release after the close are left out.
   */
  it("decides the same from stored bars as from the feed that made them", async () => {
    const fixture = goldenFixture();
    const fed = await feedBars();
    // Each symbol's final bar: no later tick pushes it out, so the feed
    // releases it only at the flush, after the close.
    const last = new Map<string, number>();
    for (const bar of fed.bars)
      last.set(bar.symbol, Math.max(last.get(bar.symbol) ?? 0, bar.ts));
    const beforeClose = fed.bars.filter(
      (bar) => bar.ts < (last.get(bar.symbol) ?? 0),
    );
    const stored = await runReplay({
      ...asInput(fixture),
      intervals: ["5m"],
      source: { kind: "candles", candles: beforeClose },
    });

    expect(stored.signals).toEqual(fed.record.signals);
    expect(stored.orders).toEqual(fed.record.orders);
    expect(stored.trades).toEqual(fed.record.trades);
    expect(stored.realizedPnl).toBe(fed.record.realizedPnl);
  });

  /**
   * The one structural difference, pinned so it is never mistaken for a bug.
   * The feed releases a session's last bar only at the end-of-day flush — no
   * later tick arrives to push it out — when the session is already closed.
   * A stored bar arrives at its own close, so a historical replay decides on
   * the final bar of the day, which live trading cannot.
   */
  it("sees the session's final bar, which the feed releases only after the close", async () => {
    const fed = await feedBars();
    const stored = await runReplay({
      ...asInput(goldenFixture()),
      intervals: ["5m"],
      source: { kind: "candles", candles: fed.bars },
    });

    const strategies = goldenFixture().strategies.length;
    expect(stored.signals.length).toBe(fed.record.signals.length + strategies);
  });
});

/** The golden day's bars, as the broker's history, shifted to other dates. */
function historical(bars: Candle[], dayOffsets: number[]): Candle[] {
  return dayOffsets.flatMap((offset) =>
    bars.map((bar) => ({
      ...bar,
      ts: bar.ts + offset * 86_400_000,
      source: "BROKER_HISTORICAL" as const,
    })),
  );
}

const HOURS = { open: "09:15", close: "15:30", squareOff: "15:12" };

describe("history, across trading days (§4.4, D6)", () => {
  /**
   * Two trading days through one pipeline: two opens, two closes, flat at
   * each end of day, realized P&L summed over both — and every Trade says its
   * entry stood on the broker's history.
   */
  it("replays consecutive days, carrying state, and ends each flat", async () => {
    const { bars } = await feedBars();
    const candles = historical(bars, [0, 1]); // Mon 5th, Tue 6th
    const { sessions, specialSessions } = sessionsFromCandles(candles, HOURS);
    const record = await runReplay({
      ...asInput(goldenFixture()),
      intervals: ["5m"],
      source: { kind: "candles", candles },
      sessions,
      specialSessions,
    });

    expect(record.sessionEvents).toEqual([
      "MARKET_OPEN",
      "MARKET_CLOSE",
      "MARKET_OPEN",
      "MARKET_CLOSE",
    ]);
    expect(record.openAtEnd).toBe(0);
    expect(record.trades.length).toBeGreaterThan(0);
    for (const trade of record.trades) {
      expect(trade.status).toBe("CLOSED");
      expect(trade.entrySource).toBe("BROKER_HISTORICAL");
    }
    const net = record.trades.reduce((sum, t) => sum + t.netPnl, 0);
    expect(net).toBeCloseTo(record.realizedPnl, 2);
  });

  /**
   * The Budget Sunday. Declared, it trades; undeclared, the session manager
   * reads a weekend as closed and the day's bars decide nothing — the silent
   * loss this task exists to prevent.
   */
  it("trades a weekend special session only when it is declared", async () => {
    const { bars } = await feedBars();
    const candles = historical(bars, [27]); // Mon 5 Jan + 27 = Sun 1 Feb
    const { sessions, specialSessions } = sessionsFromCandles(candles, HOURS);
    expect(specialSessions).toEqual(["2026-02-01"]);
    const input = {
      ...asInput(goldenFixture()),
      intervals: ["5m" as const],
      source: { kind: "candles" as const, candles },
      sessions,
    };

    const declared = await runReplay({ ...input, specialSessions });
    const undeclared = await runReplay(input);

    expect(declared.sessionEvents).toEqual(["MARKET_OPEN", "MARKET_CLOSE"]);
    expect(declared.signals.length).toBeGreaterThan(0);
    expect(undeclared.sessionEvents).toEqual([]);
    expect(undeclared.signals).toEqual([]);
  });
});
