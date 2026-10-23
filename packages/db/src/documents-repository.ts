import type { Db, Filter } from "mongodb";
import { z } from "zod";
import { COLLECTIONS } from "./collections.js";

/**
 * A knowledge document as kept (ADR §10.1 `documents`, Phase 10). Derived
 * from a research record and never authoritative: this repository keeps the
 * fields it is queried by and the rendered text; the document's shape is the
 * knowledge base's.
 */
export const KnowledgeDocDocSchema = z.object({
  docId: z.string().min(1),
  kind: z.string().min(1),
  source: z.object({
    collection: z.string().min(1),
    id: z.string().min(1),
    version: z.number().int().positive().nullable(),
    fingerprint: z.string().min(1),
  }),
  subject: z.object({ fromDate: z.string(), toDate: z.string() }),
  facets: z.object({
    symbols: z.array(z.string()),
    patterns: z.array(z.string()),
    strategies: z.array(z.string()),
    regimes: z.array(z.string()),
    outcome: z.string().optional(),
    n: z.number().int().nonnegative().optional(),
    period: z.string().optional(),
  }),
  title: z.string().min(1),
  text: z.string().min(1),
  indexVersion: z.string().min(1),
  contentFingerprint: z.string().min(1),
});
export type KnowledgeDocDoc = z.infer<typeof KnowledgeDocDocSchema>;

/** `documents` — the knowledge base's index over research (Phase 10 D3). */
export class DocumentsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection(COLLECTIONS.documents);
  }

  /** Every kept document's content and index version, by id — one read. */
  async fingerprints(): Promise<Map<string, string>> {
    const docs = await this.collection
      .find(
        {},
        {
          projection: {
            _id: 0,
            docId: 1,
            contentFingerprint: 1,
            indexVersion: 1,
          },
        },
      )
      .toArray();
    return new Map(
      docs.map((d) => [
        String(d["docId"]),
        `${String(d["indexVersion"])}|${String(d["contentFingerprint"])}`,
      ]),
    );
  }

  /**
   * Write many documents in one round trip, replacing each by its stable id.
   * The caller decides which changed (from `fingerprints`); this only writes.
   */
  async replaceMany(documents: readonly KnowledgeDocDoc[]): Promise<void> {
    if (documents.length === 0) return;
    const docs = documents.map((d) => KnowledgeDocDocSchema.parse(d));
    await this.collection.bulkWrite(
      docs.map((doc) => ({
        replaceOne: {
          filter: { docId: doc.docId },
          replacement: doc,
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  /** Remove the documents no source produces any more. */
  async remove(docIds: readonly string[]): Promise<number> {
    if (docIds.length === 0) return 0;
    const r = await this.collection.deleteMany({ docId: { $in: [...docIds] } });
    return r.deletedCount;
  }

  async findById(docId: string): Promise<KnowledgeDocDoc | null> {
    const doc = await this.collection.findOne(
      { docId },
      { projection: { _id: 0 } },
    );
    return doc === null ? null : KnowledgeDocDocSchema.parse(doc);
  }

  /** Documents matching a filter, in a stable order (Phase 10 D4). */
  async find(
    filter: Filter<KnowledgeDocDoc>,
    limit: number,
  ): Promise<KnowledgeDocDoc[]> {
    const docs = await this.collection
      .find(filter as Filter<Record<string, unknown>>, {
        projection: { _id: 0 },
      })
      .sort({ "subject.toDate": -1, docId: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => KnowledgeDocDocSchema.parse(d));
  }

  /**
   * Text search, ranked by MongoDB's text score; ties broken by date then id
   * so a result list is reproducible (Phase 10 D4).
   */
  async search(
    text: string,
    filter: Filter<KnowledgeDocDoc>,
    limit: number,
  ): Promise<(KnowledgeDocDoc & { score: number })[]> {
    const docs = await this.collection
      .find(
        { $text: { $search: text }, ...(filter as Record<string, unknown>) },
        { projection: { _id: 0, score: { $meta: "textScore" } } },
      )
      .sort({ score: { $meta: "textScore" }, "subject.toDate": -1, docId: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({
      ...KnowledgeDocDocSchema.parse(d),
      score: Number(d["score"]),
    }));
  }
}
