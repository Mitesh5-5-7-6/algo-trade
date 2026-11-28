import type { Candle } from "@neelkanth/core";

/**
 * Past signals for the learner to judge lessons on (PLAN.md 14.27): the live
 * Momentum rule replayed on stored 5m index bars — the rule behind four in
 * five paper signals (694 of 868 in the 30 days to 2026-11-28). The same
 * replica the 14.22 labs used (`scripts/meta-lab.mts`), so the learner's
 * numbers and the labs' agree:
 *
 * - an N-bar breakout beyond the EMA, 09:35–14:15, one per direction a day;
 * - entered at the next bar's open; the premium stop and target as index
 *   distances at delta ~0.5; stop first when one bar touches both; out at
 *   15:05 at the latest;
 * - costs of the vehicle paper now buys (1-step ITM, 5+ days to expiry):
 *   0.02% a round trip and 0.005% an hour of decay, in index terms.
 *
 * The replay is of the index; what an option would have paid is the same
 * approximation the labs made. Paper's own results are the forward check.
 */

const IST = 19_800_000;
export const HISTORY_COST_PCT = 0.02;
export const HISTORY_DECAY_PCT_PER_HOUR = 0.005;

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Session {
  date: string;
  bars: Bar[];
  prevClose: number | null;
}

export interface HistorySignal {
  rule: "MOMENTUM";
  underlying: "NIFTY" | "BANKNIFTY";
  date: string;
  /** The close of the signal bar — when the decision was made. */
  ts: number;
  direction: 1 | -1;
  price: number;
  todayOpen: number;
  prevClose: number | null;
  /** IST minutes since midnight of the signal bar's close. */
  minuteOfDay: number;
  /** The trade's result net of costs, in percent of the index. */
  netPct: number;
}

const minuteOf = (ts: number): number =>
  Math.floor(((ts + IST) % 86_400_000) / 60_000);
const hm = (h: number, m: number): number => h * 60 + m;
export const istDate = (ts: number): string =>
  new Date(ts + IST).toISOString().slice(0, 10);

/** The rule's settings per underlying — the paper strategies' own (2026-11-28). */
export const MOMENTUM_SETTINGS = {
  NIFTY: {
    breakoutBars: 10,
    emaPeriod: 21,
    stopPct: 0.0039,
    targetPct: 0.0094,
  },
  BANKNIFTY: {
    breakoutBars: 8,
    emaPeriod: 13,
    stopPct: 0.0106,
    targetPct: 0.0312,
  },
} as const;

/** Regular-session sessions with enough bars to trade, oldest first. */
export function sessionsOf(
  candles: readonly Pick<Candle, "ts" | "open" | "high" | "low" | "close">[],
): Session[] {
  const byDay = new Map<string, Bar[]>();
  for (const c of [...candles].sort((a, b) => a.ts - b.ts)) {
    const m = minuteOf(c.ts);
    if (m < hm(9, 15) || m > hm(15, 25)) continue;
    const date = istDate(c.ts);
    const day = byDay.get(date) ?? [];
    day.push({
      ts: c.ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    });
    byDay.set(date, day);
  }
  const out: Session[] = [];
  let prevClose: number | null = null;
  for (const [date, bars] of [...byDay.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (bars.length >= 60) out.push({ date, bars, prevClose });
    prevClose = bars.at(-1)?.close ?? prevClose;
  }
  return out;
}

function walk(
  bars: readonly Bar[],
  i: number,
  dir: 1 | -1,
  stopPct: number,
  targetPct: number,
): { exit: number; heldMinutes: number; entry: number } | null {
  const first = bars[i + 1];
  if (first === undefined) return null;
  const entry = first.open;
  const stop = entry * (1 - dir * stopPct);
  const target = entry * (1 + dir * targetPct);
  for (let j = i + 1; j < bars.length; j += 1) {
    const b = bars[j];
    if (b === undefined) break;
    const heldMinutes = minuteOf(b.ts) + 5 - minuteOf(first.ts);
    if (dir === 1 ? b.low <= stop : b.high >= stop)
      return { exit: stop, heldMinutes, entry };
    if (dir === 1 ? b.high >= target : b.low <= target)
      return { exit: target, heldMinutes, entry };
    if (minuteOf(b.ts) >= hm(15, 5))
      return { exit: b.close, heldMinutes, entry };
  }
  return null;
}

/** The Momentum rule's past signals on one underlying's sessions. */
export function momentumSignals(
  underlying: "NIFTY" | "BANKNIFTY",
  sessions: readonly Session[],
): HistorySignal[] {
  const s = MOMENTUM_SETTINGS[underlying];
  const k = 2 / (s.emaPeriod + 1);
  const out: HistorySignal[] = [];
  let ema: number | null = null;
  for (const day of sessions) {
    const open = day.bars[0]?.open ?? 0;
    let long = false;
    let short = false;
    day.bars.forEach((b, i) => {
      ema = ema === null ? b.close : b.close * k + ema * (1 - k);
      const m = minuteOf(b.ts) + 5;
      if (
        m < hm(9, 35) ||
        m > hm(14, 15) ||
        i < s.breakoutBars ||
        day.prevClose === null
      )
        return;
      const w = day.bars.slice(i - s.breakoutBars, i);
      const hi = Math.max(...w.map((x) => x.high));
      const lo = Math.min(...w.map((x) => x.low));
      for (const dir of [1, -1] as const) {
        const fires =
          dir === 1
            ? !long && b.close > hi && b.close > ema
            : !short && b.close < lo && b.close < ema;
        if (!fires) continue;
        if (dir === 1) long = true;
        else short = true;
        const r = walk(day.bars, i, dir, s.stopPct, s.targetPct);
        if (r === null) continue;
        out.push({
          rule: "MOMENTUM",
          underlying,
          date: day.date,
          ts: b.ts + 5 * 60_000,
          direction: dir,
          price: b.close,
          todayOpen: open,
          prevClose: day.prevClose,
          minuteOfDay: m,
          netPct:
            ((dir * (r.exit - r.entry)) / r.entry) * 100 -
            HISTORY_COST_PCT -
            (HISTORY_DECAY_PCT_PER_HOUR * r.heldMinutes) / 60,
        });
      }
    });
  }
  return out;
}

/**
 * An expiry day, by the rule since 2025-09-01: NIFTY weekly on Tuesday,
 * BANK NIFTY on the month's last Tuesday. A holiday that moved an expiry is
 * not known here (PLAN.md 17.x Q1) — the stored index bars begin 2025-09-29,
 * after the change to Tuesday.
 */
export function isExpiryDate(date: string, underlying: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  if (d.getUTCDay() !== 2) return false;
  return (
    underlying === "NIFTY" ||
    new Date(d.getTime() + 7 * 86_400_000).getUTCMonth() !== d.getUTCMonth()
  );
}
