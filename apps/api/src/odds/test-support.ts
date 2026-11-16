import { istDayStart, type Candle } from "@neelkanth/core";

/** The symbol every `orbDay` bar carries. */
export const ORB_DAY_SYMBOL = "NSE:NIFTY50-INDEX";

export type OrbDayKind =
  "TARGET" | "STOP" | "NEITHER" | "QUIET" | "SHORT_TARGET";

/**
 * Test-only: one 75-bar session built so ORB at its defaults does one known thing.
 *
 * The first three bars set a 15-minute opening range of 19,950–20,050: its
 * midpoint, ORB's stop, is 20,000. Bar 3 closes outside it — at 20,080 for a
 * long, whose target is then one range higher, 20,180 — and bar 5 decides.
 */
export function orbDay(date: string, kind: OrbDayKind): Candle[] {
  const bar = (
    i: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ): Candle => ({
    symbol: ORB_DAY_SYMBOL,
    interval: "5m",
    ts: istDayStart(date) + (555 + 5 * i) * 60_000,
    open,
    high,
    low,
    close,
    volume: 0,
    source: "BROKER_HISTORICAL",
    ingestionVersion: 1,
  });
  const flat = (i: number, price: number): Candle =>
    bar(i, price, price, price, price);
  const bars: Candle[] = [
    bar(0, 20_000, 20_050, 19_950, 20_000),
    bar(1, 20_000, 20_040, 19_960, 20_010),
    bar(2, 20_010, 20_040, 19_970, 20_020),
  ];
  if (kind === "QUIET") {
    for (let i = 3; i < 75; i += 1) bars.push(flat(i, 20_020));
    return bars;
  }
  if (kind === "SHORT_TARGET") {
    // Breaks down through 19,950: short from 19,920, target 19,820.
    bars.push(bar(3, 20_020, 20_020, 19_920, 19_920), flat(4, 19_920));
    bars.push(bar(5, 19_920, 19_920, 19_800, 19_810));
    for (let i = 6; i < 75; i += 1) bars.push(flat(i, 19_810));
    return bars;
  }
  bars.push(bar(3, 20_020, 20_080, 20_020, 20_080), flat(4, 20_080));
  if (kind === "TARGET") {
    bars.push(bar(5, 20_080, 20_200, 20_080, 20_190));
    for (let i = 6; i < 75; i += 1) bars.push(flat(i, 20_190));
  } else if (kind === "STOP") {
    bars.push(bar(5, 20_080, 20_080, 19_990, 19_995));
    for (let i = 6; i < 75; i += 1) bars.push(flat(i, 19_995));
  } else {
    // Drifts to 20,100 and sits there: neither level, out at the close.
    bars.push(bar(5, 20_080, 20_100, 20_080, 20_100));
    for (let i = 6; i < 75; i += 1) bars.push(flat(i, 20_100));
  }
  return bars;
}
