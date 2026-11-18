import { istDateKey, isWeekendIST, type Candle } from "@neelkanth/core";

/**
 * Fixtures for the scanner's tests: rows of the broker's two symbol files in
 * their live layout (verified 2026-11-17), and daily series stamped the way
 * FYERS stamps resolution "D" — 00:00 UTC of the IST date.
 */

const DAY = 86_400_000;

/** A futures row of NSE_FO.csv. Type 11 is an index future, 13 a stock one. */
export function futureRow(
  underlying: string,
  expiryMs: number,
  lot: number,
  underlyingFyToken: string,
  type: 11 | 13 = 13,
): string {
  return [
    `1011261123${String(lot)}`,
    `${underlying} FUT`,
    String(type),
    String(lot),
    "0.1",
    "",
    "0915-1530|1815-1915:",
    "2026-11-16",
    String(Math.floor(expiryMs / 1000)),
    `NSE:${underlying}26NOVFUT`,
    "10",
    "11",
    "61697",
    underlying,
    "2885",
    "-1.0",
    "XX",
    underlyingFyToken,
    "None",
    "0",
    "0.0",
  ].join(",");
}

/** A row of NSE_CM.csv: its fyToken first, its symbol tenth. */
export const cashRow = (
  fyToken: string,
  name: string,
  symbol: string,
): string =>
  `${fyToken},${name},0,1,0.1,INE000A00000,0915-1530|1815-1915:,2026-11-16,,${symbol},10,10,2885,${name},2885,-1.0,XX,${fyToken},None,1,3.6`;

/**
 * `count` daily bars on weekdays ending on `lastTs`, flat at 100 with real
 * volume — a series on which no condition holds.
 */
export function dailySeries(
  symbol: string,
  count: number,
  lastTs: number,
  fields: Partial<Candle> = {},
): Candle[] {
  const bars: Candle[] = [];
  for (let ts = lastTs; bars.length < count; ts -= DAY) {
    if (isWeekendIST(istDateKey(ts))) continue;
    bars.unshift({
      symbol,
      interval: "1d",
      source: "BROKER_HISTORICAL",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
      volumeAvailable: true,
      volumeQuality: "REAL",
      ts,
      ...fields,
    });
  }
  return bars;
}

/** The same series, with its last bar closing above every prior high on five times the volume. */
export function dailyBreakout(symbol: string, lastTs: number): Candle[] {
  const bars = dailySeries(symbol, 40, lastTs);
  const last = bars.at(-1);
  if (last === undefined) throw new Error("empty series");
  bars[bars.length - 1] = {
    ...last,
    high: 111,
    low: 100,
    close: 110,
    volume: 5_000,
  };
  return bars;
}
