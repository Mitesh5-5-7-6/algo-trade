import type { Db } from "mongodb";
import type { DayContext } from "@neelkanth/core";
import {
  DayContextsRepository,
  MarketEventsRepository,
  MorningReadsRepository,
  OvernightMovesRepository,
} from "@neelkanth/db";

/**
 * What the day holds before the open, from what is stored: the calendar's
 * events on the date, the US session that closed before it, and the morning
 * read of the headlines. Kept in `day_contexts`, replacing an earlier build.
 * A missing part is an empty part and a note — never a guess.
 */
export async function buildDayContext(
  db: Db,
  date: string,
  now: number,
): Promise<DayContext> {
  const [events, overnight, read] = await Promise.all([
    new MarketEventsRepository(db).onDate(date),
    new OvernightMovesRepository(db).forDate(date),
    new MorningReadsRepository(db).forDate(date),
  ]);
  const notes: string[] = [];
  if (overnight === null)
    notes.push(
      `no US overnight move stored for ${date} (Yahoo not fetched or did not answer, or a US holiday)`,
    );
  if (read === null) notes.push(`no morning read stored for ${date}`);
  else notes.push(...read.notes);
  const context: DayContext = {
    date,
    builtAt: now,
    events,
    overnight,
    flags: read?.flags ?? [],
    stockTone: read?.stockTone ?? [],
    headlinesRead: read?.headlinesRead ?? 0,
    ai: read?.ai ?? null,
    notes,
  };
  await new DayContextsRepository(db).save(context);
  return context;
}

/** The stored context for a date, built (and kept) when there is none. */
export async function dayContextFor(
  db: Db,
  date: string,
  now: number,
): Promise<DayContext> {
  return (
    (await new DayContextsRepository(db).forDate(date)) ??
    buildDayContext(db, date, now)
  );
}
