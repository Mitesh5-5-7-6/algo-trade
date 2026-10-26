import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import { sessionsFromCandles } from "./sessions.js";

/**
 * Task 4.4 (D6): a historical replay's days come from its bars.
 *
 * A trading day exists because the exchange traded — and broker bars are the
 * record that it did. A weekend date with bars is therefore a special session
 * (the Budget Sunday is in the dataset), declared to the session manager
 * rather than silently replayed as closed.
 */
const IST = (5 * 60 + 30) * 60_000;
const istTs = (y: number, mo: number, d: number, h: number, mi: number) =>
  Date.UTC(y, mo, d, h, mi) - IST;

const bar = (ts: number): Candle => ({
  symbol: "NSE:NIFTY50-INDEX",
  interval: "5m",
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 0,
  ts,
  source: "BROKER_HISTORICAL",
});

const HOURS = { open: "09:15", close: "15:30", squareOff: "15:12" };

describe("sessionsFromCandles (§4.4, D6)", () => {
  it("makes one session per IST date with bars, in order, on market hours", () => {
    const { sessions } = sessionsFromCandles(
      [
        bar(istTs(2026, 0, 6, 9, 15)),
        bar(istTs(2026, 0, 5, 9, 15)),
        bar(istTs(2026, 0, 5, 9, 20)),
      ],
      HOURS,
    );

    expect(sessions.map((s) => s.date)).toEqual(["2026-01-05", "2026-01-06"]);
    expect(sessions[0]).toEqual({
      date: "2026-01-05",
      preOpenTs: istTs(2026, 0, 5, 9, 5),
      sessionOpenTs: istTs(2026, 0, 5, 9, 15),
      squareOffTs: istTs(2026, 0, 5, 15, 12),
      afterCloseTs: istTs(2026, 0, 5, 15, 31),
    });
  });

  it("declares a weekend date with bars a special session", () => {
    const { sessions, specialSessions } = sessionsFromCandles(
      [bar(istTs(2026, 1, 1, 10, 0)), bar(istTs(2026, 1, 2, 10, 0))],
      HOURS,
    );

    expect(sessions.map((s) => s.date)).toEqual(["2026-02-01", "2026-02-02"]);
    expect(specialSessions).toEqual(["2026-02-01"]);
  });

  it("refuses an empty input rather than replaying nothing", () => {
    expect(() => sessionsFromCandles([], HOURS)).toThrow(/no bars/);
  });
});
