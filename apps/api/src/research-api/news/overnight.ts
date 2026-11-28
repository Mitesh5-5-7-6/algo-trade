import { z } from "zod";
import type { OvernightMove } from "@neelkanth/core";
import type { FetchText } from "./collector.js";

/**
 * How the US closed overnight (operator decision 2026-11-28: Yahoo's chart
 * JSON is the one outside source approved for it — Stooq shows a bot
 * challenge and FRED timed out). S&P 500 and Nasdaq Composite, close to
 * close, by US session date, each stored on the Indian weekday that opens
 * after it. Holidays on either side are ignored: a lookup is by date, and a
 * date with nothing stored says so.
 */
export const OVERNIGHT_SOURCE = "yahoo-chart";
export const SPX = "^GSPC";
export const NDX = "^IXIC";

export function yahooChartUrl(symbol: string, range: "2y" | "5d"): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
}

const ChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z
            .object({
              currentTradingPeriod: z
                .object({
                  regular: z
                    .object({ start: z.number(), end: z.number() })
                    .optional(),
                })
                .optional(),
            })
            .passthrough()
            .optional(),
          timestamp: z.array(z.number()).default([]),
          indicators: z.object({
            quote: z
              .array(z.object({ close: z.array(z.number().nullable()) }))
              .min(1),
          }),
        }),
      )
      .min(1),
  }),
});

export interface DailyClose {
  /** The US session, by its New York date. */
  usDate: string;
  close: number;
}

/** A UTC date key; a daily bar's timestamp (09:30 New York) falls on its own date. */
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The completed daily closes in a chart answer, oldest first. A missing close
 * is skipped, and so is the session still trading at `now` — its "close" is
 * only the latest price.
 */
export function parseYahooChart(json: unknown, now: number): DailyClose[] {
  const result = ChartSchema.parse(json).chart.result[0];
  if (result === undefined) return [];
  const closes = result.indicators.quote[0]?.close ?? [];
  const live = result.meta?.currentTradingPeriod?.regular;
  const out: DailyClose[] = [];
  result.timestamp.forEach((seconds, i) => {
    const close = closes[i];
    if (close === null || close === undefined || !Number.isFinite(close))
      return;
    if (live !== undefined && seconds >= live.start && now < live.end * 1000)
      return; // today's session, not closed yet
    out.push({ usDate: utcDate(seconds * 1000), close });
  });
  const byDate = new Map(out.map((c) => [c.usDate, c]));
  return [...byDate.values()].sort((a, b) => a.usDate.localeCompare(b.usDate));
}

/** Close-to-close change in percent, per US date (1.2 means +1.2%). */
export function changesByDate(
  closes: readonly DailyClose[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev === undefined || cur === undefined || prev.close === 0) continue;
    const pct = ((cur.close - prev.close) / prev.close) * 100;
    out.set(cur.usDate, Math.round(pct * 10_000) / 10_000);
  }
  return out;
}

/**
 * The Indian weekday that opens after a US session: the next Monday to
 * Friday (a Friday's close is read on Monday). Exchange holidays are not
 * consulted.
 */
export function nextIndianWeekday(usDate: string): string {
  const day = new Date(`${usDate}T00:00:00Z`);
  do day.setUTCDate(day.getUTCDate() + 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

/** The moves both indices have a change for, by the Indian date after each. */
export function toOvernightMoves(
  spx: readonly DailyClose[],
  ndx: readonly DailyClose[],
): OvernightMove[] {
  const s = changesByDate(spx);
  const n = changesByDate(ndx);
  const moves: OvernightMove[] = [];
  for (const [usDate, spxChangePct] of s) {
    const ndxChangePct = n.get(usDate);
    if (ndxChangePct === undefined) continue;
    moves.push({
      date: nextIndianWeekday(usDate),
      usDate,
      spxChangePct,
      ndxChangePct,
      source: OVERNIGHT_SOURCE,
    });
  }
  return moves.sort((a, b) => a.date.localeCompare(b.date));
}

/** Both charts fetched, one after the other, as overnight moves. */
export async function fetchOvernightMoves(deps: {
  fetchText: FetchText;
  range: "2y" | "5d";
  now: number;
}): Promise<OvernightMove[]> {
  const spx = parseYahooChart(
    JSON.parse(await deps.fetchText(yahooChartUrl(SPX, deps.range))),
    deps.now,
  );
  const ndx = parseYahooChart(
    JSON.parse(await deps.fetchText(yahooChartUrl(NDX, deps.range))),
    deps.now,
  );
  return toOvernightMoves(spx, ndx);
}
