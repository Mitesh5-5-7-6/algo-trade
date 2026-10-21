import {
  IST_OFFSET_MS,
  isWeekendIST,
  istDateKey,
  parseHHMM,
  type Candle,
} from "@neelkanth/core";
import type { ReplaySession } from "../golden/pipeline.js";

/** The intraday hours a replay's days run on — the settings' `marketHours`. */
export interface MarketHours {
  open: string;
  close: string;
  squareOff: string;
}

/** Ten minutes before the bell: early enough that the open is a transition. */
const PRE_OPEN_LEAD_MS = 10 * 60_000;
/** One minute after the bell: the first reading that sees the market shut. */
const AFTER_CLOSE_LAG_MS = 60_000;

/**
 * A historical replay's trading days, from its bars (design D6).
 *
 * The bars ARE the record that a day traded, so the days come from them
 * rather than from a holiday list that may disagree with the exchange. A
 * weekend date with bars is a special session — the Budget Sunday is in the
 * dataset — and is returned so the session manager can be told; otherwise it
 * would replay as closed and decide nothing.
 */
export function sessionsFromCandles(
  candles: readonly Candle[],
  hours: MarketHours,
): { sessions: ReplaySession[]; specialSessions: string[] } {
  if (candles.length === 0) {
    throw new Error("sessionsFromCandles: no bars — nothing to replay");
  }
  const dates = [...new Set(candles.map((c) => istDateKey(c.ts)))].sort();
  const at = (date: string, hhmm: string): number =>
    istMidnight(date) + parseHHMM(hhmm) * 60_000;

  return {
    sessions: dates.map((date) => ({
      date,
      preOpenTs: at(date, hours.open) - PRE_OPEN_LEAD_MS,
      sessionOpenTs: at(date, hours.open),
      squareOffTs: at(date, hours.squareOff),
      afterCloseTs: at(date, hours.close) + AFTER_CLOSE_LAG_MS,
    })),
    specialSessions: dates.filter((date) => isWeekendIST(date)),
  };
}

/** Epoch ms of IST midnight for a "YYYY-MM-DD" date. */
function istMidnight(date: string): number {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
}
