import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * One backtest, as kept (Phase 13 D2): which strategy and parameters, over
 * which window, under which costs, the replays it stands on and its metrics.
 * The body is the backtest's own shape; what it is queried by is at the top.
 */
export const BacktestDocSchema = z.object({
  backtestId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  strategyType: z.string().min(1),
  window: z.object({
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  stressed: z.boolean(),
  /** Where it was run for — a candidate's walk-forward fold, or by hand. */
  context: z.record(z.string(), z.unknown()),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  backtest: z.record(z.string(), z.unknown()),
});
export type BacktestDoc = z.infer<typeof BacktestDocSchema>;

/** `backtests` — research evidence, untimed, never edited (ADR §10.4). */
export class BacktestsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.backtests);
  }

  /** Keep a backtest. Never overwrites: false when its id exists. */
  async save(doc: BacktestDoc): Promise<boolean> {
    const parsed = BacktestDocSchema.parse(doc);
    const result = await this.collection.updateOne(
      { backtestId: parsed.backtestId },
      { $setOnInsert: parsed },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  async findById(backtestId: string): Promise<BacktestDoc | null> {
    const doc = await this.collection.findOne(
      { backtestId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : BacktestDocSchema.parse(doc);
  }

  async findByFingerprint(fingerprint: string): Promise<BacktestDoc[]> {
    const docs = await this.collection
      .find({ fingerprint }, { projection: { _id: 0 } })
      .sort({ createdAt: 1, backtestId: 1 })
      .toArray();
    return docs.map((d) => BacktestDocSchema.parse(d));
  }
}
