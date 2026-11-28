import type { Db } from "mongodb";
import {
  ALL_HEAVYWEIGHTS,
  heavyweightBreadth,
  MarketEventSchema,
  OvernightMoveSchema,
  signalFeatures,
  type DayContext,
  type HeavyweightQuote,
  type Lesson,
  type MarketEvent,
  type OvernightMove,
} from "@neelkanth/core";
import {
  COLLECTIONS,
  LessonsRepository,
  MorningReadSchema,
  type MorningRead,
} from "@neelkanth/db";
import {
  HISTORY_COST_PCT,
  HISTORY_DECAY_PCT_PER_HOUR,
  isExpiryDate,
  istDate,
  momentumSignals,
  sessionsOf,
  type HistorySignal,
} from "./history-signals.js";
import { judgeMenu, type JudgedSample } from "./judge.js";

const INDICES = [
  { underlying: "NIFTY", symbol: "NSE:NIFTY50-INDEX" },
  { underlying: "BANKNIFTY", symbol: "NSE:NIFTYBANK-INDEX" },
] as const;

/** Each heavyweight's 5m closes by bar-close time, and its last close per session. */
interface StockHistory {
  closeAt: Map<number, number>;
  dayClose: Map<string, number>;
  dates: string[];
}

async function stockHistory(db: Db, symbol: string): Promise<StockHistory> {
  const bars = await db
    .collection(COLLECTIONS.candles)
    .find(
      { symbol, interval: "5m" },
      { projection: { _id: 0, ts: 1, close: 1 } },
    )
    .sort({ ts: 1 })
    .toArray();
  const closeAt = new Map<number, number>();
  const dayClose = new Map<string, number>();
  for (const b of bars as unknown as Array<{ ts: number; close: number }>) {
    closeAt.set(b.ts + 5 * 60_000, b.close);
    dayClose.set(istDate(b.ts), b.close);
  }
  return { closeAt, dayClose, dates: [...dayClose.keys()].sort() };
}

/** The last session date before `date` in a sorted list, by binary search. */
function previousDate(dates: readonly string[], date: string): string | null {
  let lo = 0;
  let hi = dates.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = dates[mid] as string;
    if (d < date) {
      found = d;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The day context as it would have stood before a past session: its
 * calendar events, the US close before it, and a morning read if one was
 * kept that day. Nothing from after the open.
 */
function pastDay(
  date: string,
  events: readonly MarketEvent[],
  overnight: ReadonlyMap<string, OvernightMove>,
  reads: ReadonlyMap<string, MorningRead>,
): DayContext {
  const read = reads.get(date);
  return {
    date,
    builtAt: 0,
    events: events.filter((e) => e.date === date),
    overnight: overnight.get(date) ?? null,
    flags: read?.flags ?? [],
    stockTone: read?.stockTone ?? [],
    headlinesRead: read?.headlinesRead ?? 0,
    ai: read?.ai ?? null,
    notes: [],
  };
}

export interface LearnerResult {
  lessons: Lesson[];
  signals: number;
  sessions: number;
  from: string;
  to: string;
  /** What the run could and could not read, in words. */
  coverage: string[];
}

/**
 * One learner run over the research database (PLAN.md 14.27): replay the
 * rule, attach each past signal's conditions, judge the menu, keep the
 * verdicts. Reads `candles`, `market_events`, `overnight_moves` and
 * `morning_reads`; writes `lessons`. Never touches a trading database.
 */
export async function runLearner(
  db: Db,
  now: number,
  options: { save: boolean } = { save: true },
): Promise<LearnerResult> {
  const events = (
    await db
      .collection(COLLECTIONS.marketEvents)
      .find({}, { projection: { _id: 0 } })
      .toArray()
  )
    .map((d) => MarketEventSchema.safeParse(d))
    .flatMap((r) => (r.success ? [r.data] : []));
  const overnight = new Map(
    (
      await db
        .collection(COLLECTIONS.overnightMoves)
        .find({}, { projection: { _id: 0 } })
        .toArray()
    )
      .map((d) => OvernightMoveSchema.safeParse(d))
      .flatMap((r) => (r.success ? [[r.data.date, r.data] as const] : [])),
  );
  const reads = new Map(
    (
      await db
        .collection(COLLECTIONS.morningReads)
        .find({ ai: { $ne: null } }, { projection: { _id: 0 } })
        .toArray()
    )
      .map((d) => MorningReadSchema.safeParse(d))
      .flatMap((r) => (r.success ? [[r.data.date, r.data] as const] : [])),
  );
  const stocks = new Map<string, StockHistory>();
  for (const symbol of ALL_HEAVYWEIGHTS)
    stocks.set(symbol, await stockHistory(db, symbol));

  const groups: Array<{
    rule: string;
    underlying: string;
    strategyTypes: string[];
    samples: JudgedSample[];
  }> = [];
  const allDates = new Set<string>();
  let signalCount = 0;
  const withBreadth = { n: 0 };
  for (const { underlying, symbol } of INDICES) {
    const bars = await db
      .collection(COLLECTIONS.candles)
      .find(
        { symbol, interval: "5m" },
        { projection: { _id: 0, ts: 1, open: 1, high: 1, low: 1, close: 1 } },
      )
      .sort({ ts: 1 })
      .toArray();
    const sessions = sessionsOf(
      bars as unknown as Array<{
        ts: number;
        open: number;
        high: number;
        low: number;
        close: number;
      }>,
    );
    for (const s of sessions) allDates.add(s.date);
    const signals: HistorySignal[] = momentumSignals(underlying, sessions);
    signalCount += signals.length;
    const samples = signals.map((sig): JudgedSample => {
      const quotes = new Map<string, HeavyweightQuote>();
      for (const [stock, h] of stocks) {
        const last = h.closeAt.get(sig.ts);
        const prevDate = previousDate(h.dates, sig.date);
        const prevClose =
          prevDate === null ? undefined : h.dayClose.get(prevDate);
        if (last !== undefined && prevClose !== undefined)
          quotes.set(stock, { prevClose, last });
      }
      const breadth = heavyweightBreadth(underlying, quotes);
      if (breadth !== null) withBreadth.n += 1;
      return {
        date: sig.date,
        netPct: sig.netPct,
        features: signalFeatures({
          underlying,
          direction: sig.direction,
          minuteOfDay: sig.minuteOfDay,
          price: sig.price,
          todayOpen: sig.todayOpen,
          prevClose: sig.prevClose,
          breadth,
          day: pastDay(sig.date, events, overnight, reads),
          expiryDay: isExpiryDate(sig.date, underlying),
        }),
      };
    });
    groups.push({
      rule: "MOMENTUM",
      underlying,
      strategyTypes: ["INDEX_OPTION_MOMENTUM"],
      samples,
    });
  }

  const dates = [...allDates].sort();
  const data = {
    sessions: dates.length,
    from: dates[0] ?? "",
    to: dates.at(-1) ?? "",
    costPct: HISTORY_COST_PCT,
    decayPctPerHour: HISTORY_DECAY_PCT_PER_HOUR,
  };
  const lessons = judgeMenu(groups, now, data);
  if (options.save) {
    const repo = new LessonsRepository(db);
    await repo.ensureIndexes();
    for (const lesson of lessons) await repo.upsert(lesson);
  }
  return {
    lessons,
    signals: signalCount,
    sessions: dates.length,
    from: data.from,
    to: data.to,
    coverage: [
      `${String(signalCount)} past Momentum signals over ${String(dates.length)} sessions (${data.from} → ${data.to})`,
      `heavyweight prices for ${String(withBreadth.n)} of them${withBreadth.n === 0 ? " — the stocks' 5-minute history is not downloaded yet" : ""}`,
      `${String(events.length)} calendar events, ${String(overnight.size)} US overnight closes, ${String(reads.size)} morning reads`,
    ],
  };
}
