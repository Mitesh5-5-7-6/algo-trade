import type { SessionPhase } from "@neelkanth/core";

/** IST is UTC+5:30, no DST — a fixed offset (plan/17 §6, NSE/BSE clock). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** The IST trading date ("YYYY-MM-DD") for an instant — the session label. */
export function istDateKey(now: number): string {
  const ist = new Date(now + IST_OFFSET_MS);
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${String(ist.getUTCFullYear())}-${month}-${day}`;
}

const DAY_MS = 86_400_000;

/**
 * Epoch ms of IST midnight for the instant's trading date — the "today"
 * boundary day-scoped read models filter on (same clock as istDateKey).
 */
export function startOfDayIST(now: number): number {
  return Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

function parseHHMM(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid HH:MM time: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
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
  exchange: string;
}

export const NSE_DEFAULT_SESSION: SessionConfig = {
  preOpen: "09:00",
  open: "09:15",
  close: "15:30",
  holidays: [],
  exchange: "NSE",
};

export interface SessionEvaluation {
  phase: SessionPhase;
  /** The phase differs from the last evaluation (write hot:session). */
  phaseChanged: boolean;
  /** A real closed/pre-open → open transition occurred (emit MARKET_OPEN). */
  marketOpened: boolean;
  /** A real open → closed transition occurred (emit MARKET_CLOSE). */
  marketClosed: boolean;
}

interface IstWallClock {
  dateKey: string; // YYYY-MM-DD
  weekday: number; // 0=Sun … 6=Sat
  minuteOfDay: number;
}

/**
 * Tracks the exchange session (plan/17 §6): computes phase from the clock and
 * calendar, and reports the transitions that drive `hot:session` and
 * MARKET_OPEN/MARKET_CLOSE. Session state is a property of market-data reality,
 * so its authority lives with the Market Data Engine (plan/17 §6); many read
 * it (strategy gating, risk check 1, paper validation, EOD reconcile).
 *
 * The clock is injected (`evaluate(now)`), which is what makes the whole thing
 * deterministically testable — no wall-clock dependency in the logic.
 */
export class SessionManager {
  private readonly preOpenMin: number;
  private readonly openMin: number;
  private readonly closeMin: number;
  private readonly holidays: ReadonlySet<string>;
  private previous: SessionPhase | null = null;

  constructor(config: SessionConfig = NSE_DEFAULT_SESSION) {
    this.preOpenMin = parseHHMM(config.preOpen);
    this.openMin = parseHHMM(config.open);
    this.closeMin = parseHHMM(config.close);
    this.holidays = new Set(config.holidays);
    if (!(this.preOpenMin <= this.openMin && this.openMin < this.closeMin)) {
      throw new Error("session times must satisfy preOpen ≤ open < close");
    }
  }

  private static toIst(now: number): IstWallClock {
    const ist = new Date(now + IST_OFFSET_MS);
    return {
      dateKey: istDateKey(now),
      weekday: ist.getUTCDay(),
      minuteOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    };
  }

  private phaseAt(now: number): SessionPhase {
    const { dateKey, weekday, minuteOfDay } = SessionManager.toIst(now);
    const isWeekend = weekday === 0 || weekday === 6;
    if (isWeekend || this.holidays.has(dateKey)) return "closed";
    if (minuteOfDay < this.preOpenMin) return "closed";
    if (minuteOfDay < this.openMin) return "pre-open";
    if (minuteOfDay < this.closeMin) return "open";
    return "closed";
  }

  /**
   * Pure phase query — no edge tracking. Callers that only need "what phase is
   * it at `now`?" (e.g. the equity sampler) MUST use this, not `evaluate()`:
   * evaluate advances the internal previous-phase state, so a second caller
   * would swallow the open/close transition the session loop relies on.
   */
  phase(now: number): SessionPhase {
    return this.phaseAt(now);
  }

  /**
   * Evaluate the session at `now`. The very first evaluation reports
   * `phaseChanged` (so `hot:session` is written) but never a market
   * open/close transition — we don't know the prior state, and an honest
   * "no transition" beats a fabricated one (plan/17 §5 honesty rule). Real
   * transitions after boot emit MARKET_OPEN/MARKET_CLOSE correctly.
   */
  evaluate(now: number): SessionEvaluation {
    const phase = this.phaseAt(now);
    const previous = this.previous;
    this.previous = phase;

    if (previous === null) {
      return {
        phase,
        phaseChanged: true,
        marketOpened: false,
        marketClosed: false,
      };
    }
    return {
      phase,
      phaseChanged: phase !== previous,
      marketOpened: phase === "open" && previous !== "open",
      marketClosed: previous === "open" && phase !== "open",
    };
  }
}
