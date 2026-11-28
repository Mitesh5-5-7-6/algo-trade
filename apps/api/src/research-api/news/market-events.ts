import { readFileSync } from "node:fs";
import { z } from "zod";
import { MarketEventSchema, type MarketEvent } from "@neelkanth/core";

/**
 * The event calendar, `market-events.json`: RBI policy decisions, the Union
 * Budget and US FOMC decisions, each with the page its date was read on.
 * Resolved from the package root so it is found the same from `src` under
 * the tests and from `dist` in the service (tsc does not copy JSON).
 */
const DEFAULT_FILE = new URL(
  "../../../src/research-api/news/market-events.json",
  import.meta.url,
);

const CalendarFileSchema = z.object({
  about: z.string(),
  verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  events: z.array(
    MarketEventSchema.extend({
      /** What the source page says — kept in the file, not in the database. */
      evidence: z.string().min(1),
      source: z.string().url(),
    }),
  ),
});

export function loadMarketEvents(
  path: string | URL = DEFAULT_FILE,
): MarketEvent[] {
  const file = CalendarFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return file.events.map((e) => ({
    date: e.date,
    kind: e.kind,
    title: e.title,
    symbols: e.symbols,
    source: e.source,
  }));
}

/** Loads the calendar into `market_events`; how many events were new. */
export async function seedMarketEvents(
  events: readonly MarketEvent[],
  upsert: (event: MarketEvent) => Promise<boolean>,
): Promise<number> {
  let added = 0;
  for (const event of events) if (await upsert(event)) added += 1;
  return added;
}
