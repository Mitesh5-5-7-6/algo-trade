import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

const SessionDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * One paper reconciliation run (Phase 14 D6): when, at which point in the day,
 * and whether the book and the trading state agreed. A mismatch's detail is
 * the risk event it names; this records that the run happened at all.
 */
export const PaperReconciliationDocSchema = z.object({
  runId: z.string().min(1),
  session: SessionDateSchema,
  /** BOOT runs once per process start; CLOSE at the session-close transition. */
  at: z.enum(["BOOT", "CLOSE"]),
  ts: z.number().int().nonnegative(),
  clean: z.boolean(),
  mismatches: z.number().int().nonnegative(),
  riskEventId: z.string().min(1).optional(),
});
export type PaperReconciliationDoc = z.infer<
  typeof PaperReconciliationDocSchema
>;

/** `paper_reconciliations` — append-only, in the paper database. */
export class PaperReconciliationsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.paperReconciliations);
  }

  async insert(run: PaperReconciliationDoc): Promise<void> {
    const doc = PaperReconciliationDocSchema.parse(run);
    await this.collection.insertOne({ ...doc });
  }

  /** A session's runs, in the order they happened. */
  async forSession(session: string): Promise<PaperReconciliationDoc[]> {
    const docs = await this.collection
      .find({ session }, { projection: { _id: 0 } })
      .sort({ ts: 1 })
      .toArray();
    return docs.map((doc) => PaperReconciliationDocSchema.parse(doc));
  }
}
