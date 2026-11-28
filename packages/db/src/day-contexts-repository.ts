import type { Db } from "mongodb";
import { z } from "zod";
import {
  DayContextSchema,
  DayFlagSchema,
  StockToneSchema,
  type DayContext,
} from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * What the day holds before the open, one row per IST date — RESEARCH
 * database only. Rebuilt from the calendar, the overnight move and the
 * morning read; a rebuild replaces the row.
 */
export class DayContextsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.dayContexts);
  }

  async save(context: DayContext): Promise<void> {
    const doc = DayContextSchema.parse(context);
    await this.collection.replaceOne({ date: doc.date }, doc, { upsert: true });
  }

  async forDate(date: string): Promise<DayContext | null> {
    const doc = await this.collection.findOne(
      { date },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : DayContextSchema.parse(doc);
  }
}

/**
 * One morning read of the headlines: what the model found, which headlines it
 * was shown (by id), who read them and why anything was dropped. Kept apart
 * from the day context so a rebuild of the context — a later overnight fetch —
 * never loses or repeats the read.
 */
export const MorningReadSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  at: z.number().int().nonnegative(),
  flags: z.array(DayFlagSchema),
  stockTone: z.array(StockToneSchema),
  headlinesRead: z.number().int().nonnegative(),
  /** The newsIds of the headlines sent — the only ids a flag may cite. */
  headlineIds: z.array(z.string()),
  ai: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
      at: z.number().int().nonnegative(),
    })
    .nullable(),
  notes: z.array(z.string()),
});
export type MorningRead = z.infer<typeof MorningReadSchema>;

/** `morning_reads` — one per IST date; a read taken again replaces it. */
export class MorningReadsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.morningReads);
  }

  async save(read: MorningRead): Promise<void> {
    const doc = MorningReadSchema.parse(read);
    await this.collection.replaceOne({ date: doc.date }, doc, { upsert: true });
  }

  async forDate(date: string): Promise<MorningRead | null> {
    const doc = await this.collection.findOne(
      { date },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : MorningReadSchema.parse(doc);
  }
}
