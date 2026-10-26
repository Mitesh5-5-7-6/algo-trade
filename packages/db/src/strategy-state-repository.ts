import type { Db } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * One strategy instance's persisted state (§0.5.6).
 *
 * `type` and `stateVersion` are stored alongside the snapshot because they are
 * what makes restoring it safe. A snapshot is an opaque blob whose meaning
 * lives entirely in the code that wrote it; read it back into a different
 * strategy, or into a later build whose fields mean something else, and the
 * result is a running strategy with plausible state and no error anywhere.
 */
export const StrategyStateSchema = z.object({
  strategyId: z.string().min(1),
  symbol: z.string().min(1),
  /** The strategy TYPE, e.g. `ORB` — the shape's owner. */
  type: z.string().min(1),
  stateVersion: z.string().min(1),
  snapshot: z.unknown(),
  updatedAt: z.number().int().positive(),
});
/**
 * Declared rather than inferred: `z.unknown()` makes its key OPTIONAL in the
 * inferred type, and under `exactOptionalPropertyTypes` an optional snapshot
 * is a different thing from one that is always present and may be undefined.
 * The snapshot is always present.
 */
export interface StrategyState {
  strategyId: string;
  symbol: string;
  type: string;
  stateVersion: string;
  snapshot: unknown;
  updatedAt: number;
}

/**
 * Strategy state across process lifetimes (§0.5.6).
 *
 * A strategy accumulates state bar by bar — an opening range, the previous
 * bar's EMAs, a one-shot latch — and a process that restarts at 11:00 has
 * built none of it. The bars are in Mongo; what they *mean* to a strategy is
 * not, and cannot be recomputed without replaying every decision.
 *
 * Small and hot: one row per (strategy, symbol), overwritten on change. No
 * history is kept, because the question is only ever "what does this instance
 * currently believe?" — and the audit trail of what it decided already exists
 * in `signals`.
 */
export class StrategyStateRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.strategyState);
  }

  async save(state: StrategyState): Promise<void> {
    const doc = StrategyStateSchema.parse(state);
    await this.collection.updateOne(
      { strategyId: doc.strategyId, symbol: doc.symbol },
      { $set: doc },
      { upsert: true },
    );
  }

  async load(
    strategyId: string,
    symbol: string,
  ): Promise<StrategyState | null> {
    const doc = await this.collection.findOne(
      { strategyId, symbol },
      { projection: { _id: 0 } },
    );
    if (doc === null) return null;
    const parsed = StrategyStateSchema.parse(doc);
    return { ...parsed, snapshot: parsed.snapshot };
  }

  /**
   * Drop a strategy's state, for every symbol.
   *
   * Called when a strategy is deleted or its params change: params are not in
   * the snapshot, so a state built under one configuration would silently
   * carry into another.
   */
  async clear(strategyId: string): Promise<number> {
    const result = await this.collection.deleteMany({ strategyId });
    return result.deletedCount;
  }
}
