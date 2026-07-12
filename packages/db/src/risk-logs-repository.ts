import type { Db } from "mongodb";
import { RiskLogSchema, type RiskLog } from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/**
 * Risk logs (plan/07 `risk_logs`): every risk decision, approvals and blocks
 * alike, append-only, sole-written by the Risk Engine (plan/14 §7). Proves the
 * gate ran and why it decided as it did.
 */
export class RiskLogsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.riskLogs);
  }

  async insert(log: RiskLog): Promise<void> {
    const doc = RiskLogSchema.parse(log);
    await this.collection.insertOne({ ...doc });
  }

  /** Recent decisions (optionally only blocks) for the operator's audit view. */
  async findRecent(limit: number, onlyBlocked = false): Promise<RiskLog[]> {
    const filter = onlyBlocked ? { decision: "blocked" } : {};
    const docs = await this.collection
      .find(filter, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => RiskLogSchema.parse(doc));
  }
}
