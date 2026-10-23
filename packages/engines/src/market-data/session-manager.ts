import {
  isTradingDayIST,
  IST_OFFSET_MS,
  NSE_DEFAULT_SESSION,
  istDateKey,
  parseHHMM,
  type SessionConfig,
  type SessionPhase,
} from "@neelkanth/core";

/**
 * The clock and calendar primitives this file used to own — `istDateKey`,
 * `startOfDayIST`, `tradingDaysBetween`, `SessionConfig`, `NSE_DEFAULT_SESSION`
 * — now live in `@neelkanth/core`. Historical ingestion has to agree with the
 * live session about what a trading day is, and it runs in `broker`, which
 * cannot import this package. Import them from `@neelkanth/core` directly;
 * they are deliberately not re-exported here, so there is one address for each.
 */

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
  private readonly specialSessions: ReadonlySet<string>;
  private previous: SessionPhase | null = null;

  constructor(config: SessionConfig = NSE_DEFAULT_SESSION) {
    this.preOpenMin = parseHHMM(config.preOpen);
    this.openMin = parseHHMM(config.open);
    this.closeMin = parseHHMM(config.close);
    this.holidays = new Set(config.holidays);
    this.specialSessions = new Set(config.specialSessions ?? []);
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
    const { dateKey, minuteOfDay } = SessionManager.toIst(now);
    // One rule for whether a day existed, shared with ingestion: a holiday
    // closes it, a special session opens a weekend, otherwise weekdays trade.
    if (!isTradingDayIST(dateKey, this.holidays, this.specialSessions))
      return "closed";
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
