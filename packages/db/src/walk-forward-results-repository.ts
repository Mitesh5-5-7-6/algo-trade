import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * One walk-forward of a candidate (Phase 13 D4): its folds, choices and
 * pooled out-of-sample record, as the walk-forward produced them, and the
 * gate's verdict on it once judged (D6).
 */
export const WalkForwardDocSchema = z.object({
  walkForwardId: z.string().min(1),
  candidateId: z.string().regex(/^SC-\d{4,}$/),
  createdAt: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  result: z.record(z.string(), z.unknown()),
});
export type WalkForwardDoc = z.infer<typeof WalkForwardDocSchema>;

/** `walk_forward_results` — research evidence, never edited (ADR §10.4). */
export class WalkForwardResultsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.walkForwardResults);
  }

  /** Keep a walk-forward. Never overwrites: false when its id exists. */
  async save(doc: WalkForwardDoc): Promise<boolean> {
    const parsed = WalkForwardDocSchema.parse(doc);
    const result = await this.collection.updateOne(
      { walkForwardId: parsed.walkForwardId },
      { $setOnInsert: parsed },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  async findById(walkForwardId: string): Promise<WalkForwardDoc | null> {
    const doc = await this.collection.findOne(
      { walkForwardId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : WalkForwardDocSchema.parse(doc);
  }

  /** A candidate's walk-forwards, oldest first. */
  async forCandidate(candidateId: string): Promise<WalkForwardDoc[]> {
    const docs = await this.collection
      .find({ candidateId }, { projection: { _id: 0 } })
      .sort({ createdAt: 1, walkForwardId: 1 })
      .toArray();
    return docs.map((d) => WalkForwardDocSchema.parse(d));
  }
}
