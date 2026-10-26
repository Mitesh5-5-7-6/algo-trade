import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

const SessionDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * A kept paper session report (Phase 14 D6). The report itself is the
 * application's shape, stored whole; the fields beside it are what it is
 * found by.
 */
export const PaperSessionReportDocSchema = z.object({
  reportId: z.string().min(1),
  session: SessionDateSchema,
  generatedAt: z.number().int().nonnegative(),
  /** Whether the session reconciled clean and the replay agreed throughout. */
  clean: z.boolean(),
  report: z.record(z.string(), z.unknown()),
});
export type PaperSessionReportDoc = z.infer<typeof PaperSessionReportDocSchema>;

/** `paper_session_reports` — insert-only, in the paper database. */
export class PaperSessionReportsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.paperSessionReports);
  }

  /** Keep a report. False when one with this id is already kept. */
  async save(report: PaperSessionReportDoc): Promise<boolean> {
    const doc = PaperSessionReportDocSchema.parse(report);
    const result = await this.collection.updateOne(
      { reportId: doc.reportId },
      { $setOnInsert: doc },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  }

  /** Every report taken of a session, oldest first. */
  async forSession(session: string): Promise<PaperSessionReportDoc[]> {
    const docs = await this.collection
      .find({ session }, { projection: { _id: 0 } })
      .sort({ generatedAt: 1 })
      .toArray();
    return docs.map((doc) => PaperSessionReportDocSchema.parse(doc));
  }

  /** The latest report of each session, newest session first. */
  async latestPerSession(limit: number): Promise<PaperSessionReportDoc[]> {
    const docs = await this.collection
      .aggregate([
        { $sort: { generatedAt: -1 } },
        { $group: { _id: "$session", doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } },
        { $project: { _id: 0 } },
        { $sort: { session: -1 } },
        { $limit: limit },
      ])
      .toArray();
    return docs.map((doc) => PaperSessionReportDocSchema.parse(doc));
  }
}
