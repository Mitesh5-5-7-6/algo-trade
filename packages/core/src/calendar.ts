/**
 * The exchange clock and calendar.
 *
 * This lives in `core` rather than with the Market Data Engine because it is a
 * domain fact, not engine behaviour: what an IST trading date is, and which
 * days the exchange was open, does not depend on who is asking. Historical
 * ingestion in `broker` has to agree with the live session in `engines` about
 * both, and `broker` cannot import `engines` — so a shared lower layer is the
 * only place the two can meet without one of them keeping a second copy.
 *
 * `SessionManager` — the stateful part that tracks phase transitions — stays in
 * `engines`, because that is behaviour and has exactly one owner.
 */

/** IST is UTC+5:30, no DST — a fixed offset (plan/17 §6, NSE/BSE clock). */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

const DAY_MS = 86_400_000;

/** The IST trading date ("YYYY-MM-DD") for an instant — the session label. */
export function istDateKey(now: number): string {
  const ist = new Date(now + IST_OFFSET_MS);
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${String(ist.getUTCFullYear())}-${month}-${day}`;
}

/**
 * Epoch ms of IST midnight for the instant's trading date — the "today"
 * boundary day-scoped read models filter on (same clock as istDateKey).
 */
export function startOfDayIST(now: number): number {
  return Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** Minutes past IST midnight for an instant — the session-window coordinate. */
export function minuteOfDayIST(now: number): number {
  const ist = new Date(now + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** Parse an IST "HH:MM" session boundary into minutes past midnight. */
export function parseHHMM(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid HH:MM time: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

/** True when an IST date key falls on a Saturday or Sunday. */
export function isWeekendIST(dateKey: string): boolean {
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * The IST trading dates in `[fromTs, toTs]`, weekends and exchange holidays
 * removed (docs/design/PHASE_1_HISTORICAL_DATA.md D5).
 *
 * Research windows are counted in trading days, never calendar days
 * (RND_RESEARCH_SPECIFICATION §5.5) — a week containing a holiday is four
 * sessions, and an aggregation that assumes five is wrong in a way that is
 * very hard to see afterwards.
 *
 * It also makes a backfill able to tell two indistinguishable things apart: a
 * day the exchange was shut and a day the fetch failed. Both return zero
 * candles; only one is a problem. Without this, every Diwali would log as a
 * gap and a genuinely missing session would be lost in the noise.
 *
 * `holidays` comes from the same global settings the live `SessionManager`
 * reads, so ingestion and trading cannot disagree about whether a day existed.
 * Inclusive of both ends; an inverted range yields nothing.
 */
export function tradingDaysBetween(
  fromTs: number,
  toTs: number,
  holidays: ReadonlySet<string>,
  specialSessions: ReadonlySet<string> = EMPTY,
): string[] {
  const days: string[] = [];
  if (toTs < fromTs) return days;
  // Step over IST midnights rather than adding 24h to `fromTs`, so the result
  // does not drift with the time of day the range happens to start at.
  const lastDay = startOfDayIST(toTs);
  for (let day = startOfDayIST(fromTs); day <= lastDay; day += DAY_MS) {
    const dateKey = istDateKey(day);
    if (!isTradingDayIST(dateKey, holidays, specialSessions)) continue;
    days.push(dateKey);
  }
  return days;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Whether the exchange was open on an IST date.
 *
 * **A weekend is not conclusive.** NSE runs special live sessions on
 * Saturdays and Sundays — the Union Budget session on 1 February, and the
 * Diwali Muhurat session — and they are real trading days with real volume.
 * A calendar that treats the weekend rule as absolute silently discards them:
 * the first one-year backfill rejected 75 genuine bars for Sunday
 * 2026-02-01 before `specialSessions` existed.
 *
 * Precedence, and the order matters:
 *
 * 1. an explicit holiday closes the day, even if it is also listed as a
 *    special session — a declared closure is a stronger statement than a
 *    calendar convention, and a date in both lists is a configuration
 *    mistake that should fail closed;
 * 2. a special session opens a weekend day;
 * 3. otherwise, weekdays are open and weekends are not.
 */
export function isTradingDayIST(
  dateKey: string,
  holidays: ReadonlySet<string>,
  specialSessions: ReadonlySet<string> = EMPTY,
): boolean {
  if (holidays.has(dateKey)) return false;
  if (specialSessions.has(dateKey)) return true;
  return !isWeekendIST(dateKey);
}

export interface SessionConfig {
  /** Pre-open auction start, IST "HH:MM" (NSE default 09:00). */
  preOpen: string;
  /** Regular session open, IST "HH:MM" (NSE default 09:15). */
  open: string;
  /** Regular session close, IST "HH:MM" (NSE default 15:30). */
  close: string;
  /** Exchange holidays as "YYYY-MM-DD" IST dates. */
  holidays: readonly string[];
  /**
   * Weekend dates the exchange opened anyway — the Budget and Muhurat
   * sessions (see `isTradingDayIST`). Absent means none.
   */
  specialSessions?: readonly string[];
  exchange: string;
}

export const NSE_DEFAULT_SESSION: SessionConfig = {
  preOpen: "09:00",
  open: "09:15",
  close: "15:30",
  holidays: [],
  exchange: "NSE",
};
