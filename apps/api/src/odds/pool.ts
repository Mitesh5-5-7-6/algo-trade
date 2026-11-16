import {
  istDateKey,
  istDayStart,
  isWeekendIST,
  NSE_DEFAULT_SESSION,
  parseHHMM,
  type Candle,
  type SessionConfig,
} from "@neelkanth/core";

/** Bumped whenever which sessions enter the pool changes. */
export const ODDS_POOL_VERSION = "1";

/** One regular session: every bar from the bell to the close, in order. */
export interface PoolSession {
  date: string;
  bars: Candle[];
}

/** A session with bars that the pool left out, and why. */
export interface PoolExclusion {
  date: string;
  /**
   * `SPECIAL_SESSION` — a weekend date, or one the calendar declares (Budget,
   * Muhurat). `INCOMPLETE` — its bars are not exactly the regular grid.
   */
  reason: "SPECIAL_SESSION" | "INCOMPLETE";
  bars: number;
}

export interface SessionPool {
  /** Bars in a full regular session at this interval — 75 for NSE at 5m. */
  barsPerSession: number;
  /** Oldest first. Bar `i` of every session is the same time of day. */
  sessions: PoolSession[];
  excluded: PoolExclusion[];
}

export interface PoolOptions {
  /** The plan's IST date. The pool holds only sessions strictly before it. */
  planDate: string;
  /** Defaults to 5: the stored research interval. */
  intervalMinutes?: number;
  /** The hours and declared special sessions; NSE's regular day by default. */
  session?: SessionConfig;
}

/**
 * The sessions a plan's odds are drawn from (design §6.1 D2, D8).
 *
 * Only full regular sessions, so that bar `i` of one is the same time of day
 * as bar `i` of every other — which is what drawing "a bar from the same time
 * of day" needs. A special or short session is left out and listed rather
 * than padded. And only sessions before the plan's own date: a pool that
 * holds the plan's day has already seen how it ended.
 */
export function buildPool(
  candles: readonly Candle[],
  options: PoolOptions,
): SessionPool {
  const session = options.session ?? NSE_DEFAULT_SESSION;
  const interval = options.intervalMinutes ?? 5;
  const openMinute = parseHHMM(session.open);
  const barsPerSession = (parseHHMM(session.close) - openMinute) / interval;
  const special = new Set(session.specialSessions ?? []);

  const byDate = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = istDateKey(candle.ts);
    if (date >= options.planDate) continue;
    const bars = byDate.get(date);
    if (bars === undefined) byDate.set(date, [candle]);
    else bars.push(candle);
  }

  const sessions: PoolSession[] = [];
  const excluded: PoolExclusion[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const bars = (byDate.get(date) ?? []).sort((a, b) => a.ts - b.ts);
    if (special.has(date) || isWeekendIST(date)) {
      excluded.push({ date, reason: "SPECIAL_SESSION", bars: bars.length });
      continue;
    }
    const firstTs = istDayStart(date) + openMinute * 60_000;
    const onGrid =
      bars.length === barsPerSession &&
      bars.every((bar, i) => bar.ts === firstTs + i * interval * 60_000);
    if (!onGrid) {
      excluded.push({ date, reason: "INCOMPLETE", bars: bars.length });
      continue;
    }
    sessions.push({ date, bars });
  }
  return { barsPerSession, sessions, excluded };
}
