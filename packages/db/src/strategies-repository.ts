import type { Db } from "mongodb";
import { StrategyConfigSchema, type StrategyConfig } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * Strategies (plan/07 `strategies`): the operator's primary artifact — what
 * the machine should run — owned by the Strategy Engine and mutated via the
 * control plane (plan/05 §4). Soft-deleted (status flag), never hard-deleted,
 * so history referencing a strategy stays intact (plan/07 §3).
 */
export class StrategiesRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.strategies);
  }

  async create(config: StrategyConfig): Promise<StrategyConfig> {
    const doc = StrategyConfigSchema.parse(config);
    await this.collection.insertOne({ ...doc });
    return doc;
  }

  async findById(strategyId: string): Promise<StrategyConfig | null> {
    const doc = await this.collection.findOne(
      { strategyId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : StrategyConfigSchema.parse(doc);
  }

  /** All non-deleted strategies for an owner (dashboard list). */
  async listByOwner(ownerId: string): Promise<StrategyConfig[]> {
    const docs = await this.collection
      .find({ ownerId, status: { $ne: "deleted" } }, { projection: { _id: 0 } })
      .toArray();
    return docs.map((doc) => StrategyConfigSchema.parse(doc));
  }

  /** The set the engine runs: enabled and active (plan/15 §8). */
  async findEnabled(): Promise<StrategyConfig[]> {
    const docs = await this.collection
      .find({ enabled: true, status: "active" }, { projection: { _id: 0 } })
      .toArray();
    return docs.map((doc) => StrategyConfigSchema.parse(doc));
  }

  /** Patch config/params; validates the merged result. Returns null if absent. */
  async update(
    strategyId: string,
    patch: Partial<Omit<StrategyConfig, "strategyId" | "createdAt">>,
  ): Promise<StrategyConfig | null> {
    const current = await this.findById(strategyId);
    if (current === null) return null;
    const next = StrategyConfigSchema.parse({
      ...current,
      ...patch,
      strategyId,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    });
    await this.collection.updateOne({ strategyId }, { $set: next });
    return next;
  }

  async setEnabled(
    strategyId: string,
    enabled: boolean,
  ): Promise<StrategyConfig | null> {
    return this.update(strategyId, { enabled });
  }

  async softDelete(strategyId: string): Promise<void> {
    await this.collection.updateOne(
      { strategyId },
      { $set: { status: "deleted", enabled: false, updatedAt: Date.now() } },
    );
  }
}
