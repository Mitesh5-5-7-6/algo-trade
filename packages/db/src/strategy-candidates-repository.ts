import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * A strategy candidate (Phase 13 D1): one replayable strategy, the grid of
 * parameter variants a walk-forward may choose among, the instruments, and
 * the registered hypothesis it comes from (spec §5.2). Declared once.
 */
export const StrategyCandidateDocSchema = z.object({
  candidateId: z.string().regex(/^SC-\d{4,}$/, "candidate ids are SC-NNNN"),
  createdAt: z.number().int().nonnegative(),
  strategyType: z.string().min(1),
  /** The variants, in the order ties are broken by; {} is the configured strategy. */
  grid: z.array(z.record(z.string(), z.unknown())).min(1).max(12),
  symbols: z.array(z.string().min(1)).min(1),
  hypothesisId: z.string().regex(/^H-\d{4,}$/),
  statement: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type StrategyCandidateDoc = z.infer<typeof StrategyCandidateDocSchema>;

/** `strategy_candidates` — declared once, never edited (ADR §10.4). */
export class StrategyCandidatesRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.strategyCandidates);
  }

  /** Keep a candidate. Never overwrites: false when its id exists. */
  async save(doc: StrategyCandidateDoc): Promise<boolean> {
    const parsed = StrategyCandidateDocSchema.parse(doc);
    const result = await this.collection.updateOne(
      { candidateId: parsed.candidateId },
      { $setOnInsert: parsed },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  async findById(candidateId: string): Promise<StrategyCandidateDoc | null> {
    const doc = await this.collection.findOne(
      { candidateId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : StrategyCandidateDocSchema.parse(doc);
  }

  async findByFingerprint(
    fingerprint: string,
  ): Promise<StrategyCandidateDoc[]> {
    const docs = await this.collection
      .find({ fingerprint }, { projection: { _id: 0 } })
      .toArray();
    return docs.map((d) => StrategyCandidateDocSchema.parse(d));
  }

  /** Every candidate, oldest first. */
  async list(): Promise<StrategyCandidateDoc[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: 1, candidateId: 1 })
      .toArray();
    return docs.map((d) => StrategyCandidateDocSchema.parse(d));
  }
}
