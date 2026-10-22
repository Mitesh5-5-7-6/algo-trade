import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * One strategy experiment, as kept in the research database (ADR §10.1).
 *
 * `kind` says which experiment it is; Phase 6's counterfactual runs are the
 * first. The manifest and result are stored as the experiment produced them —
 * their shape is the experiment's, and this repository persists rather than
 * reinterprets them. The fingerprint is what makes two runs comparable.
 */
export const StrategyExperimentDocSchema = z.object({
  experimentId: z.string().min(1),
  /**
   * COUNTERFACTUAL — a Phase 6 run. HYPOTHESIS — a claim registered before
   * its test (Phase 7 D3). HYPOTHESIS_TEST — that claim tested, once (D4).
   */
  kind: z.enum(["COUNTERFACTUAL", "HYPOTHESIS", "HYPOTHESIS_TEST"]),
  createdAt: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  manifest: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
});
export type StrategyExperimentDoc = z.infer<typeof StrategyExperimentDocSchema>;

/** `strategy_experiments` — research evidence, untimed (ADR §10.4). */
export class StrategyExperimentsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.strategyExperiments);
  }

  /** Keep an experiment. Never overwrites: false when the id is taken. */
  async save(experiment: StrategyExperimentDoc): Promise<boolean> {
    const doc = StrategyExperimentDocSchema.parse(experiment);
    const result = await this.collection.updateOne(
      { experimentId: doc.experimentId },
      { $setOnInsert: doc },
      { upsert: true },
    );
    return result.upsertedCount > 0;
  }

  async findById(experimentId: string): Promise<StrategyExperimentDoc | null> {
    const doc = await this.collection.findOne(
      { experimentId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : StrategyExperimentDocSchema.parse(doc);
  }

  /** Every experiment of one kind, oldest first. */
  async listByKind(
    kind: StrategyExperimentDoc["kind"],
  ): Promise<StrategyExperimentDoc[]> {
    const docs = await this.collection
      .find({ kind }, { projection: { _id: 0 } })
      .sort({ createdAt: 1, experimentId: 1 })
      .toArray();
    return docs.map((doc) => StrategyExperimentDocSchema.parse(doc));
  }

  /** Every run of this exact experiment, oldest first. */
  async findByFingerprint(
    fingerprint: string,
  ): Promise<StrategyExperimentDoc[]> {
    const docs = await this.collection
      .find({ fingerprint }, { projection: { _id: 0 } })
      .sort({ createdAt: 1, experimentId: 1 })
      .toArray();
    return docs.map((doc) => StrategyExperimentDocSchema.parse(doc));
  }
}
