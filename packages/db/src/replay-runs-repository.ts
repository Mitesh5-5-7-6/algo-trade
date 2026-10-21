import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * One replay run, as kept in the research database (Phase 4 Q2).
 *
 * The manifest and record are stored as the replay produced them; their
 * shape is owned by the replay, and this repository persists rather than
 * reinterprets them. The fingerprint is what makes a run comparable.
 */
export const ReplayRunDocSchema = z.object({
  runId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  /** sha256 of the canonical manifest and record. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  strategyId: z.string().min(1),
  manifest: z.record(z.string(), z.unknown()),
  record: z.record(z.string(), z.unknown()),
});
export type ReplayRunDoc = z.infer<typeof ReplayRunDocSchema>;

/**
 * `replay_runs` — research evidence, untimed (ADR §10.4).
 *
 * Only ever used against the research database. A replay's Trades live inside
 * its run and never in `trades`, so nothing reading production outcomes can
 * mistake a replay for something that happened.
 */
export class ReplayRunsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.replayRuns);
  }

  /**
   * Keep a run. Never overwrites: false when the id is already taken, because
   * a run is a record of what was measured once.
   */
  async save(run: ReplayRunDoc): Promise<boolean> {
    const doc = ReplayRunDocSchema.parse(run);
    const result = await this.collection.updateOne(
      { runId: doc.runId },
      { $setOnInsert: doc },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  async findByRunId(runId: string): Promise<ReplayRunDoc | null> {
    const doc = await this.collection.findOne(
      { runId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : ReplayRunDocSchema.parse(doc);
  }

  /** Every run of this exact replay, oldest first. */
  async findByFingerprint(fingerprint: string): Promise<ReplayRunDoc[]> {
    const docs = await this.collection
      .find({ fingerprint }, { projection: { _id: 0 } })
      .sort({ createdAt: 1, runId: 1 })
      .toArray();
    return docs.map((doc) => ReplayRunDocSchema.parse(doc));
  }
}
