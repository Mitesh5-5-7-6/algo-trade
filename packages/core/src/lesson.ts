import { z } from "zod";
import { eventKindsOn, type DayContext } from "./day-context.js";
import { heavyweightsOf, type HeavyweightBreadth } from "./heavyweights.js";

/**
 * The learning system (PLAN.md 14.26–14.28, operator decision 2026-11-28,
 * option A): every signal's conditions are kept; a judge tests a fixed menu
 * of lessons — "skip a call when most heavyweights are down" — on data each
 * lesson did not learn from; a lesson that passes is SHOWN to the operator,
 * who applies it to paper behind the step-up password. The system never
 * applies a lesson itself (PLAN §3: AI may not approve its own strategy).
 */

/** What was known about the market when a signal fired — nothing later. */
export const SignalFeaturesSchema = z.object({
  underlying: z.string().min(1),
  /** 1 for a bullish trade (a bought call), -1 for a bearish one (a bought put). */
  direction: z.union([z.literal(1), z.literal(-1)]),
  /** IST minutes since midnight, of the bar the signal closed on. */
  minuteOfDay: z.number().int().min(0).max(1440),
  /** The index's move from today's open, in percent, signed WITH the trade. */
  indexFromOpenWithPct: z.number().nullable(),
  /** The index's move from yesterday's close, in percent, signed WITH the trade. */
  indexDayWithPct: z.number().nullable(),
  heavyweights: z
    .object({
      total: z.number().int().positive(),
      /** How many move with the trade: up for a call, down for a put. */
      withCount: z.number().int().nonnegative(),
      againstCount: z.number().int().nonnegative(),
      /** Their average move from yesterday's close, signed with the trade. */
      avgWithPct: z.number(),
    })
    .nullable(),
  /** Event kinds on the day: the calendar's and the morning read's. */
  events: z.array(z.string()),
  /** The S&P 500's overnight move, in percent, signed with the trade. */
  overnightWithPct: z.number().nullable(),
  /**
   * The morning read's news tone on the heavyweights, signed with the trade,
   * as a share of the heavyweights (-1..1); null when no read ran.
   */
  newsWith: z.number().min(-1).max(1).nullable(),
  /** An expiry day for this underlying. */
  expiryDay: z.boolean(),
});
export type SignalFeatures = z.infer<typeof SignalFeaturesSchema>;

/** Inputs to `signalFeatures`, as the runtime and the history replay both hold them. */
export interface SignalFeatureInput {
  underlying: string;
  direction: 1 | -1;
  minuteOfDay: number;
  price: number;
  todayOpen: number | null;
  prevClose: number | null;
  breadth: HeavyweightBreadth | null;
  day: DayContext | null;
  expiryDay: boolean;
}

/** One function for live and for history, so a lesson judged on one reads the same on the other. */
export function signalFeatures(input: SignalFeatureInput): SignalFeatures {
  const d = input.direction;
  const pct = (from: number | null): number | null =>
    from !== null && from > 0
      ? ((d * (input.price - from)) / from) * 100
      : null;
  const b = input.breadth;
  const tone = input.day?.stockTone ?? [];
  const names = heavyweightsOf(input.underlying);
  const toneSum = tone
    .filter((t) => names.includes(t.symbol))
    .reduce((s, t) => s + t.tone, 0);
  return {
    underlying: input.underlying,
    direction: d,
    minuteOfDay: input.minuteOfDay,
    indexFromOpenWithPct: pct(input.todayOpen),
    indexDayWithPct: pct(input.prevClose),
    heavyweights:
      b === null
        ? null
        : {
            total: b.total,
            withCount: d === 1 ? b.up : b.down,
            againstCount: d === 1 ? b.down : b.up,
            avgWithPct: d * b.avgChangePct,
          },
    events: [...eventKindsOn(input.day)].sort(),
    overnightWithPct:
      input.day?.overnight == null
        ? null
        : d * input.day.overnight.spxChangePct,
    newsWith:
      input.day?.ai == null || names.length === 0
        ? null
        : Math.max(-1, Math.min(1, (d * toneSum) / names.length)),
    expiryDay: input.expiryDay,
  };
}

/** The menu of lesson conditions. Fixed: the judge tests these, it does not invent new ones. */
export const LessonConditionSchema = z.discriminatedUnion("kind", [
  /** Take the trade only when at least this share of heavyweights move with it. */
  z.object({
    kind: z.literal("HEAVYWEIGHTS_WITH"),
    minShare: z.number().gt(0).max(1),
  }),
  /** Skip the trade when this share or more of heavyweights move against it. */
  z.object({
    kind: z.literal("HEAVYWEIGHTS_NOT_AGAINST"),
    maxAgainstShare: z.number().gt(0).max(1),
  }),
  /** Skip days carrying any of these events. */
  z.object({
    kind: z.literal("SKIP_EVENT_DAY"),
    events: z.array(z.string().min(1)).min(1),
  }),
  /** Skip when the US moved this much or more AGAINST the trade overnight. */
  z.object({
    kind: z.literal("OVERNIGHT_NOT_AGAINST"),
    maxAgainstPct: z.number().positive(),
  }),
  /** Take the trade only when the US moved with it overnight by at least this much. */
  z.object({
    kind: z.literal("OVERNIGHT_WITH"),
    minPct: z.number().nonnegative(),
  }),
  /** Skip when the morning's heavyweight news leans against the trade. */
  z.object({ kind: z.literal("NEWS_NOT_AGAINST") }),
  /** Skip the underlying's expiry day. */
  z.object({ kind: z.literal("SKIP_EXPIRY_DAY") }),
  /** Take the trade only when the index is already up (call) / down (put) on the day by this much. */
  z.object({
    kind: z.literal("INDEX_DAY_WITH"),
    minPct: z.number().nonnegative(),
  }),
  /** Take the trade only inside this IST window, minutes since midnight. */
  z.object({
    kind: z.literal("TIME_WINDOW"),
    fromMinute: z.number().int().min(0).max(1440),
    toMinute: z.number().int().min(0).max(1440),
  }),
]);
export type LessonCondition = z.infer<typeof LessonConditionSchema>;

/** A lesson's verdict on one signal. `unknown`: an input it needs was missing. */
export type LessonJudgement = "pass" | "block" | "unknown";

export function judgeLesson(
  c: LessonCondition,
  f: SignalFeatures,
): LessonJudgement {
  const verdict = (pass: boolean): LessonJudgement => (pass ? "pass" : "block");
  switch (c.kind) {
    case "HEAVYWEIGHTS_WITH":
      return f.heavyweights === null
        ? "unknown"
        : verdict(
            f.heavyweights.withCount / f.heavyweights.total >= c.minShare,
          );
    case "HEAVYWEIGHTS_NOT_AGAINST":
      return f.heavyweights === null
        ? "unknown"
        : verdict(
            f.heavyweights.againstCount / f.heavyweights.total <
              c.maxAgainstShare,
          );
    case "SKIP_EVENT_DAY":
      return verdict(!c.events.some((e) => f.events.includes(e)));
    case "OVERNIGHT_NOT_AGAINST":
      return f.overnightWithPct === null
        ? "unknown"
        : verdict(f.overnightWithPct > -c.maxAgainstPct);
    case "OVERNIGHT_WITH":
      return f.overnightWithPct === null
        ? "unknown"
        : verdict(f.overnightWithPct >= c.minPct);
    case "NEWS_NOT_AGAINST":
      return f.newsWith === null ? "unknown" : verdict(f.newsWith >= 0);
    case "SKIP_EXPIRY_DAY":
      return verdict(!f.expiryDay);
    case "INDEX_DAY_WITH":
      return f.indexDayWithPct === null
        ? "unknown"
        : verdict(f.indexDayWithPct >= c.minPct);
    case "TIME_WINDOW":
      return verdict(
        f.minuteOfDay >= c.fromMinute && f.minuteOfDay <= c.toMinute,
      );
  }
}

const hhmm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const share = (s: number): string => `${String(Math.round(s * 100))}%`;

/** The lesson in plain words, for the dashboard. */
export function describeLesson(c: LessonCondition): string {
  switch (c.kind) {
    case "HEAVYWEIGHTS_WITH":
      return `Take a trade only when at least ${share(c.minShare)} of the index's heavyweight stocks move with it`;
    case "HEAVYWEIGHTS_NOT_AGAINST":
      return `Skip a trade when ${share(c.maxAgainstShare)} or more of the heavyweight stocks move against it`;
    case "SKIP_EVENT_DAY":
      return `Skip days with: ${c.events.join(", ")}`;
    case "OVERNIGHT_NOT_AGAINST":
      return `Skip a trade when the US (S&P 500) moved ${String(c.maxAgainstPct)}% or more against it overnight`;
    case "OVERNIGHT_WITH":
      return `Take a trade only when the US (S&P 500) moved at least ${String(c.minPct)}% with it overnight`;
    case "NEWS_NOT_AGAINST":
      return "Skip a trade when the morning news on the heavyweight stocks leans against it";
    case "SKIP_EXPIRY_DAY":
      return "Skip the index's expiry day";
    case "INDEX_DAY_WITH":
      return `Take a call only when the index is up ${String(c.minPct)}% or more on the day (a put: down)`;
    case "TIME_WINDOW":
      return `Take trades only between ${hhmm(c.fromMinute)} and ${hhmm(c.toMinute)}`;
  }
}

/** Results of a set of trades, net of costs, in percent of the index. */
export const LessonStatsSchema = z.object({
  n: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(1).nullable(),
  /** Gross wins over gross losses; null with no losing trade. */
  profitFactor: z.number().nonnegative().nullable(),
  avgNetPct: z.number().nullable(),
});
export type LessonStats = z.infer<typeof LessonStatsSchema>;

const PeriodSchema = z.object({
  from: z.string(),
  to: z.string(),
  all: LessonStatsSchema,
  kept: LessonStatsSchema,
  blocked: LessonStatsSchema,
  /** Signals the lesson could not judge — an input missing. */
  unknown: z.number().int().nonnegative(),
});

export const LessonVerdictSchema = z.enum([
  "PASSED",
  "FAILED",
  "WAITING_FOR_DATA",
]);
export type LessonVerdict = z.infer<typeof LessonVerdictSchema>;

/** The rule a lesson was judged on, and the strategies it may then be applied to. */
export const LessonScopeSchema = z.object({
  rule: z.string().min(1),
  underlying: z.string().min(1),
  strategyTypes: z.array(z.string().min(1)).min(1),
});
export type LessonScope = z.infer<typeof LessonScopeSchema>;

/** A judged lesson — what the research service keeps and the dashboard shows. */
export const LessonSchema = z.object({
  /** Stable across runs: the same condition on the same scope is the same lesson. */
  lessonId: z.string().min(1),
  scope: LessonScopeSchema,
  condition: LessonConditionSchema,
  summary: z.string().min(1),
  learn: PeriodSchema,
  test: PeriodSchema,
  /** One-sided permutation p-value: kept trades beat blocked ones in the test period. */
  pValue: z.number().min(0).max(1).nullable(),
  /** The Holm threshold this lesson's p-value had to clear in its run. */
  holmThreshold: z.number().min(0).max(1).nullable(),
  verdict: LessonVerdictSchema,
  reasons: z.array(z.string()),
  judgedAt: z.number().int().nonnegative(),
  /** The sessions the run read, and the cost model, so a verdict can be traced. */
  data: z.object({
    sessions: z.number().int().nonnegative(),
    from: z.string(),
    to: z.string(),
    costPct: z.number().nonnegative(),
    decayPctPerHour: z.number().nonnegative(),
  }),
});
export type Lesson = z.infer<typeof LessonSchema>;

/** A lesson the operator applied to paper (PAPER database). */
export const AppliedLessonSchema = z.object({
  lessonId: z.string().min(1),
  scope: LessonScopeSchema,
  condition: LessonConditionSchema,
  summary: z.string().min(1),
  status: z.enum(["ACTIVE", "STOPPED"]),
  appliedAt: z.number().int().nonnegative(),
  appliedBy: z.string().min(1),
  stoppedAt: z.number().int().nonnegative().optional(),
  /** The verdict and test-period numbers when it was applied — what it promised. */
  promised: z.object({ test: PeriodSchema, pValue: z.number().nullable() }),
});
export type AppliedLesson = z.infer<typeof AppliedLessonSchema>;

/** A signal's conditions as kept (PAPER database), for the learner's forward check. */
export const SignalContextSchema = z.object({
  signalId: z.string().min(1),
  strategyId: z.string().min(1),
  strategyType: z.string().min(1),
  symbol: z.string().min(1),
  ts: z.number().int().nonnegative(),
  features: SignalFeaturesSchema,
  /** Each active lesson's verdict on this signal. */
  lessons: z.array(
    z.object({
      lessonId: z.string(),
      judgement: z.enum(["pass", "block", "unknown"]),
    }),
  ),
});
export type SignalContext = z.infer<typeof SignalContextSchema>;

/**
 * The verdict of every applied lesson in scope on one signal: blocked when any
 * ACTIVE lesson blocks it. A lesson that cannot judge (an input missing — the
 * research service down, the morning read absent) does not block: a lesson
 * is an improvement the operator chose, not a safety check, and R&D must not
 * be required for trading (ADR §5.6). The judgement is kept either way.
 */
export function applyLessons(
  lessons: readonly AppliedLesson[],
  strategyType: string,
  features: SignalFeatures,
): {
  blocked: AppliedLesson | null;
  judgements: Array<{ lessonId: string; judgement: LessonJudgement }>;
} {
  let blocked: AppliedLesson | null = null;
  const judgements: Array<{ lessonId: string; judgement: LessonJudgement }> =
    [];
  for (const lesson of lessons) {
    if (lesson.status !== "ACTIVE") continue;
    if (lesson.scope.underlying !== features.underlying) continue;
    if (!lesson.scope.strategyTypes.includes(strategyType)) continue;
    const judgement = judgeLesson(lesson.condition, features);
    judgements.push({ lessonId: lesson.lessonId, judgement });
    if (judgement === "block" && blocked === null) blocked = lesson;
  }
  return { blocked, judgements };
}
