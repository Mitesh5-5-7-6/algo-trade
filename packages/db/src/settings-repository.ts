import type { Db } from "mongodb";
import { z } from "zod";
import { RiskRulesSchema } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * Global settings (plan/07 `settings`): capital, global risk limits, and —
 * safety-critical — the persisted kill flag. A restart must never silently
 * resume a killed system (plan/07, plan/12 §4): the composition root reads
 * `tradingEnabled` at boot and stays halted until the operator re-enables.
 *
 * Repository pattern (plan/05 §4): intent-named methods, Zod-validated at
 * the boundary, sole Mongo access for this collection.
 */
export const GlobalSettingsSchema = z.object({
  scope: z.literal("global"),
  capitalAllocation: z.number().nonnegative(),
  globalRiskLimits: RiskRulesSchema,
  marketHours: z.object({
    open: z.string().regex(/^\d{2}:\d{2}$/), // "09:15" IST
    close: z.string().regex(/^\d{2}:\d{2}$/), // "15:30" IST
    squareOff: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  tradingEnabled: z.boolean(),
  updatedAt: z.number().int().positive(),
});
export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

/** Conservative boot defaults: trading disabled until the operator enables. */
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  scope: "global",
  capitalAllocation: 0,
  globalRiskLimits: {
    maxDailyLoss: 25_000,
    maxOpenPositions: 6,
    maxExposure: 0.6,
  },
  marketHours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  tradingEnabled: false,
  updatedAt: 0,
};

export class SettingsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.settings);
  }

  /** Read global settings; seeds the conservative default row if absent. */
  async getGlobal(): Promise<GlobalSettings> {
    const doc = await this.collection.findOne(
      { scope: "global" },
      { projection: { _id: 0 } },
    );
    if (doc === null) {
      const seeded = { ...DEFAULT_GLOBAL_SETTINGS, updatedAt: Date.now() };
      await this.collection.updateOne(
        { scope: "global" },
        { $setOnInsert: seeded },
        { upsert: true },
      );
      return seeded;
    }
    return GlobalSettingsSchema.parse(doc);
  }

  /** Partial update; validates the merged result before writing. */
  async updateGlobal(
    patch: Partial<Omit<GlobalSettings, "scope" | "updatedAt">>,
  ): Promise<GlobalSettings> {
    const current = await this.getGlobal();
    const next = GlobalSettingsSchema.parse({
      ...current,
      ...patch,
      scope: "global",
      updatedAt: Date.now(),
    });
    await this.collection.updateOne(
      { scope: "global" },
      { $set: next },
      { upsert: true },
    );
    return next;
  }

  /** The kill path's persistence (plan/12 §4): one flag, one writer path. */
  async setTradingEnabled(enabled: boolean): Promise<GlobalSettings> {
    return this.updateGlobal({ tradingEnabled: enabled });
  }
}
