import {
  ALL_HEAVYWEIGHTS,
  applyLessons,
  DayContextSchema,
  describeLesson,
  directionalSide,
  heavyweightBreadth,
  istDateKey,
  signalFeatures,
  startOfDayIST,
  type AppliedLesson,
  type Candle,
  type DayContext,
  type HeavyweightQuote,
  type Signal,
  type SignalContext,
  type SignalFeatures,
} from "@neelkanth/core";

/** The index symbol of each underlying a lesson can concern. */
export const INDEX_OF: Readonly<Record<string, string>> = {
  NIFTY: "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
};
const UNDERLYING_OF: Readonly<Record<string, string>> = {
  "NSE:NIFTY50-INDEX": "NIFTY",
  "NSE:NIFTYBANK-INDEX": "BANKNIFTY",
};

/** IST minutes since midnight. */
const istMinute = (ts: number): number =>
  Math.floor((ts - startOfDayIST(ts)) / 60_000);

export interface LessonDeskDeps {
  /** Stored bars in [from, to), oldest first — the trading database's own. */
  findBars(symbol: string, from: number, to: number): Promise<Candle[]>;
  readPrice(symbol: string): number | null;
  /** The underlying's nearest option expiry (epoch ms), from the symbol master. */
  nearestExpiry(underlying: string, now: number): number | null;
  /** The research service's day context; absent, lessons that need it say "unknown". */
  fetchDayContext?: (date: string) => Promise<unknown>;
  readActiveLessons(): Promise<AppliedLesson[]>;
  persistContext(context: SignalContext): Promise<void>;
  onError(error: unknown, context: Record<string, unknown>): void;
}

/**
 * The trading side of the learning system (PLAN.md 14.26, 14.28).
 *
 * Holds, in memory, what a signal's conditions are read from — yesterday's
 * closes, today's index opens, the day context, the applied lessons — so the
 * Risk Engine's lesson check reads a value already computed and never waits
 * on the database or the research service on the critical path (D16).
 */
export class LessonDesk {
  private readonly deps: LessonDeskDeps;
  private readonly prevClose = new Map<string, number>();
  private readonly todayOpen = new Map<string, number>();
  private day = "";
  private dayContext: DayContext | null = null;
  private dayContextAt = 0;
  private lessons: AppliedLesson[] = [];
  private readonly verdicts = new Map<
    string,
    { blocked: boolean; detail: string } | null
  >();
  private lessonsAt = Number.NEGATIVE_INFINITY;
  private openTriedAt = Number.NEGATIVE_INFINITY;
  private refreshing = false;

  constructor(deps: LessonDeskDeps) {
    this.deps = deps;
  }

  /** The applied lessons in force — re-read on each tick, so an apply takes effect within a minute. */
  async refreshLessons(now = Date.now()): Promise<void> {
    if (now - this.lessonsAt < 60_000) return;
    this.lessonsAt = now;
    try {
      this.lessons = await this.deps.readActiveLessons();
    } catch (error) {
      this.deps.onError(error, { where: "LessonDesk.refreshLessons" });
    }
  }

  /**
   * Yesterday's closes and today's opens, once a day; the day context every
   * 15 minutes until it carries a morning read, then hourly. Cheap when held.
   */
  async refreshDay(now: number): Promise<void> {
    // One refresh at a time: the session tick does not wait for this one.
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.refreshDayOnce(now);
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshDayOnce(now: number): Promise<void> {
    const date = istDateKey(now);
    if (this.day !== date) {
      this.day = date;
      this.prevClose.clear();
      this.todayOpen.clear();
      this.dayContext = null;
      this.dayContextAt = 0;
      this.openTriedAt = Number.NEGATIVE_INFINITY;
      const todayStart = startOfDayIST(now);
      for (const symbol of [...Object.values(INDEX_OF), ...ALL_HEAVYWEIGHTS]) {
        try {
          const before = await this.deps.findBars(
            symbol,
            todayStart - 7 * 86_400_000,
            todayStart,
          );
          const last = before.at(-1);
          if (last !== undefined) this.prevClose.set(symbol, last.close);
        } catch (error) {
          this.day = ""; // try again on the next tick
          this.deps.onError(error, { where: "LessonDesk.refreshDay", symbol });
        }
      }
    }
    // An index's open: its first bar of today, looked for once a minute until it exists.
    const wantOpen = Object.values(INDEX_OF).filter(
      (s) => !this.todayOpen.has(s),
    );
    if (wantOpen.length > 0 && now - this.openTriedAt >= 60_000)
      this.openTriedAt = now;
    else wantOpen.length = 0;
    for (const symbol of wantOpen) {
      try {
        const bars = await this.deps.findBars(
          symbol,
          startOfDayIST(now),
          now + 1,
        );
        const first = bars[0];
        if (first !== undefined) this.todayOpen.set(symbol, first.open);
      } catch (error) {
        this.deps.onError(error, { where: "LessonDesk.todayOpen", symbol });
      }
    }
    const fetch = this.deps.fetchDayContext;
    const every = this.dayContext?.ai == null ? 15 * 60_000 : 60 * 60_000;
    if (fetch !== undefined && now - this.dayContextAt >= every) {
      this.dayContextAt = now;
      try {
        const parsed = DayContextSchema.safeParse(await fetch(date));
        if (parsed.success && parsed.data.date === date)
          this.dayContext = parsed.data;
        else if (!parsed.success)
          this.deps.onError(
            new Error("the research service's day context did not parse"),
            {
              where: "LessonDesk.dayContext",
              issues: parsed.error.issues.slice(0, 3),
            },
          );
      } catch (error) {
        this.deps.onError(error, { where: "LessonDesk.dayContext" });
      }
    }
  }

  /** What the dashboard can show of the day as the trading process holds it. */
  currentDay(): DayContext | null {
    return this.dayContext;
  }

  /** The features of an entry signal, from what is held now. Null for a signal on no known index. */
  featuresFor(signal: Signal, now: number): SignalFeatures | null {
    if (signal.side === "HOLD") return null;
    const index = signal.underlyingSymbol ?? signal.symbol;
    const underlying = UNDERLYING_OF[index];
    if (underlying === undefined) return null;
    const price = this.deps.readPrice(index) ?? signal.contextSnapshot.price;
    const quotes = new Map<string, HeavyweightQuote>();
    for (const symbol of ALL_HEAVYWEIGHTS) {
      const prevClose = this.prevClose.get(symbol);
      const last = this.deps.readPrice(symbol);
      if (prevClose !== undefined && last !== null)
        quotes.set(symbol, { prevClose, last });
    }
    const expiry = this.deps.nearestExpiry(underlying, now);
    return signalFeatures({
      underlying,
      direction:
        directionalSide({ ...signal, side: signal.side }) === "BUY" ? 1 : -1,
      minuteOfDay: istMinute(signal.ts),
      price,
      todayOpen: this.todayOpen.get(index) ?? null,
      prevClose: this.prevClose.get(index) ?? null,
      breadth: heavyweightBreadth(underlying, quotes),
      day: this.dayContext,
      expiryDay: expiry !== null && istDateKey(expiry) === istDateKey(now),
    });
  }

  /**
   * Judge an entry signal against the applied lessons, keep its conditions,
   * and hold the verdict for the Risk Engine. Never throws: a failure here
   * leaves the signal with no lesson verdict, which blocks nothing.
   */
  judge(signal: Signal, strategyType: string, now: number): void {
    try {
      const features = this.featuresFor(signal, now);
      if (features === null) return;
      const { blocked, judgements } = applyLessons(
        this.lessons,
        strategyType,
        features,
      );
      this.verdicts.set(
        signal.signalId,
        judgements.length === 0
          ? null
          : blocked === null
            ? {
                blocked: false,
                detail: `lessons passed: ${judgements.map((j) => `${j.lessonId} ${j.judgement}`).join(", ")}`,
              }
            : {
                blocked: true,
                detail: `lesson: ${describeLesson(blocked.condition)}`,
              },
      );
      void this.deps
        .persistContext({
          signalId: signal.signalId,
          strategyId: signal.strategyId,
          strategyType,
          symbol: signal.symbol,
          ts: signal.ts,
          features,
          lessons: judgements,
        })
        .catch((error: unknown) => {
          this.deps.onError(error, {
            where: "LessonDesk.persist",
            signalId: signal.signalId,
          });
        });
    } catch (error) {
      this.deps.onError(error, {
        where: "LessonDesk.judge",
        signalId: signal.signalId,
      });
    }
  }

  /** The Risk Engine's read: the verdict `judge` held for this signal, once. */
  verdictFor(signal: Signal): { blocked: boolean; detail: string } | null {
    const verdict = this.verdicts.get(signal.signalId) ?? null;
    this.verdicts.delete(signal.signalId);
    return verdict;
  }
}
