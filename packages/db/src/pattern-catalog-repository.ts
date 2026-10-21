import type { Db } from "mongodb";
import {
  definitionKey,
  PatternDefinitionSchema,
  type PatternDefinition,
} from "@neelkanth/core";
import { COLLECTIONS } from "./collections.js";

/** A version whose catalogued definition is not the one now running. */
export interface DefinitionConflict {
  patternId: string;
  detectorVersion: string;
  catalogued: PatternDefinition;
  running: PatternDefinition;
}

export interface CatalogOutcome {
  /** `patternId@detectorVersion` entries this call added. */
  added: string[];
  /** Already catalogued, identically. */
  known: string[];
  /**
   * Already catalogued, DIFFERENTLY: a rule changed without its version being
   * bumped. Never overwritten — the catalogued text is what earlier
   * observations were made under — and a caller must not record new ones.
   */
  conflicts: DefinitionConflict[];
}

/**
 * The detector catalogue (`patterns`, Phase 5 D5).
 *
 * Insert-once, like observations: a version's definition is written the first
 * time that version runs and never changed after. That is what lets an
 * observation six months old be read against the rule that produced it, even
 * after the code has moved on to 2.0.0.
 */
export class PatternCatalogRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.patterns);
  }

  async register(
    definitions: readonly PatternDefinition[],
  ): Promise<CatalogOutcome> {
    const outcome: CatalogOutcome = { added: [], known: [], conflicts: [] };
    for (const raw of definitions) {
      const running = PatternDefinitionSchema.parse(raw);
      const id = {
        patternId: running.patternId,
        detectorVersion: running.detectorVersion,
      };
      const label = `${running.patternId}@${running.detectorVersion}`;
      const result = await this.collection.updateOne(
        id,
        { $setOnInsert: running },
        { upsert: true },
      );
      if (result.upsertedCount > 0) {
        outcome.added.push(label);
        continue;
      }
      const catalogued = await this.find(
        running.patternId,
        running.detectorVersion,
      );
      if (
        catalogued !== null &&
        definitionKey(catalogued) === definitionKey(running)
      ) {
        outcome.known.push(label);
      } else if (catalogued !== null) {
        outcome.conflicts.push({ ...id, catalogued, running });
      }
    }
    return outcome;
  }

  async find(
    patternId: string,
    detectorVersion: string,
  ): Promise<PatternDefinition | null> {
    const doc = await this.collection.findOne(
      { patternId, detectorVersion },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : PatternDefinitionSchema.parse(doc);
  }

  /** Every catalogued definition, by pattern then version. */
  async list(): Promise<PatternDefinition[]> {
    const docs = await this.collection
      .find({}, { projection: { _id: 0 } })
      .sort({ patternId: 1, detectorVersion: 1 })
      .toArray();
    return docs.map((doc) => PatternDefinitionSchema.parse(doc));
  }
}
