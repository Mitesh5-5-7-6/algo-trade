import { z } from "zod";

/**
 * What the day holds before the open (PLAN.md Phase 20, operator decision
 * 2026-11-28): scheduled events, the US session that closed overnight, and
 * the morning read of the headlines. Built by the research service; read by
 * the trading process as context only — it can block an entry through an
 * applied lesson, never start one (Phase 20 D3).
 */

/** An IST session date, YYYY-MM-DD. */
const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const MarketEventKindSchema = z.enum([
  "RBI_POLICY",
  "UNION_BUDGET",
  "FOMC",
  "RESULTS",
  "OTHER",
]);
export type MarketEventKind = z.infer<typeof MarketEventKindSchema>;

/** A scheduled event, by the Indian session it affects, with where it was read. */
export const MarketEventSchema = z.object({
  date: DateKeySchema,
  kind: MarketEventKindSchema,
  title: z.string().min(1),
  /** The stocks it concerns, e.g. ["NSE:HDFCBANK-EQ"] for a results day. */
  symbols: z.array(z.string()).default([]),
  /** Where the date was read — a calendar is evidence, not memory. */
  source: z.string().min(1),
});
export type MarketEvent = z.infer<typeof MarketEventSchema>;

/** The US session that closed before an Indian session opened. */
export const OvernightMoveSchema = z.object({
  /** The Indian session that opens after it. */
  date: DateKeySchema,
  /** The US session, by its own (New York) date. */
  usDate: DateKeySchema,
  /** S&P 500, close to close, in percent: 1.2 means +1.2%. */
  spxChangePct: z.number(),
  /** Nasdaq Composite, close to close, in percent. */
  ndxChangePct: z.number(),
  source: z.string().min(1),
});
export type OvernightMove = z.infer<typeof OvernightMoveSchema>;

export const DayFlagKindSchema = z.enum([
  "RBI_POLICY",
  "UNION_BUDGET",
  "FOMC",
  "RESULTS",
  "GLOBAL_RISK_OFF",
  "GLOBAL_RISK_ON",
  "MAJOR_NEGATIVE",
  "MAJOR_POSITIVE",
  "OTHER_EVENT",
]);
export type DayFlagKind = z.infer<typeof DayFlagKindSchema>;

const ToneSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);

/** One thing the morning read found — every flag cites the headlines it rests on. */
export const DayFlagSchema = z.object({
  kind: DayFlagKindSchema,
  detail: z.string().min(1).max(300),
  symbols: z.array(z.string()).default([]),
  /** For the market: -1 bad, 0 mixed or unclear, 1 good. */
  tone: ToneSchema,
  headlineIds: z.array(z.string().min(1)).min(1),
});
export type DayFlag = z.infer<typeof DayFlagSchema>;

/** The news tone on one heavyweight stock, citing its headlines. */
export const StockToneSchema = z.object({
  symbol: z.string().min(1),
  tone: ToneSchema,
  headlineIds: z.array(z.string().min(1)).min(1),
});
export type StockTone = z.infer<typeof StockToneSchema>;

export const DayContextSchema = z.object({
  date: DateKeySchema,
  builtAt: z.number().int().nonnegative(),
  events: z.array(MarketEventSchema),
  overnight: OvernightMoveSchema.nullable(),
  flags: z.array(DayFlagSchema),
  stockTone: z.array(StockToneSchema),
  headlinesRead: z.number().int().nonnegative(),
  /** Who read the headlines; null when no AI read ran. */
  ai: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
      at: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Why a part is missing — "no AI key configured", "Yahoo did not answer". */
  notes: z.array(z.string()),
});
export type DayContext = z.infer<typeof DayContextSchema>;

/** A headline as collected — the link and title only, never the article. */
export const NewsItemSchema = z.object({
  /** The first 16 hex characters of sha256(canonical url). */
  newsId: z.string().min(1),
  /** "economictimes", "livemint", "google-news", "rbi". */
  source: z.string().min(1),
  feed: z.string().min(1),
  url: z.string().min(1),
  title: z.string().min(1),
  publishedAt: z.number().int().nonnegative(),
  ingestedAt: z.number().int().nonnegative(),
  /** Heavyweights the title names, e.g. ["NSE:HDFCBANK-EQ"]. */
  symbols: z.array(z.string()),
  /** Keyword topics: "RBI", "FED", "BUDGET", "RESULTS", "US_MARKETS", "CRUDE", "FII". */
  topics: z.array(z.string()),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

/**
 * The scheduled kinds the calendar alone may name. A morning-read flag of
 * these kinds is NOT counted: a misread headline (an RBI circular read as a
 * policy day) must not turn an ordinary day into an event day for a lesson
 * that skips event days. The calendar carries a source for each date.
 */
const CALENDAR_ONLY = new Set<string>(["RBI_POLICY", "UNION_BUDGET", "FOMC"]);

/** The event kinds on a date: the calendar's, and the morning read's unscheduled ones. */
export function eventKindsOn(context: DayContext | null): Set<string> {
  const kinds = new Set<string>();
  if (context === null) return kinds;
  for (const e of context.events) kinds.add(e.kind);
  for (const f of context.flags)
    if (!CALENDAR_ONLY.has(f.kind)) kinds.add(f.kind);
  return kinds;
}
