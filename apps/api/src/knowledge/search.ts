import type { Db, Filter } from "mongodb";
import { DocumentsRepository, type KnowledgeDocDoc } from "@neelkanth/db";
import type { KnowledgeKind } from "./document.js";

export const MAX_RESULTS = 200;

/** A knowledge query (Phase 10 D4, D5). Every list facet matches any of its values. */
export interface KnowledgeQuery {
  /** Free text, ranked by relevance; absent for a purely structured query. */
  text?: string;
  kinds?: KnowledgeKind[];
  symbols?: string[];
  patterns?: string[];
  strategies?: string[];
  regimes?: string[];
  /** WIN / LOSS / FLAT for a Trade; a verdict for a finding. */
  outcome?: string;
  /** Research whose subject overlaps `[fromDate, toDate]`. */
  fromDate?: string;
  toDate?: string;
  /**
   * Nothing about a period that ended after this date (D5): an agent asking
   * "what did we know on D?" is never shown research about D + 1.
   */
  asOf?: string;
  limit?: number;
}

export interface KnowledgeHit {
  docId: string;
  kind: string;
  title: string;
  text: string;
  subject: KnowledgeDocDoc["subject"];
  facets: KnowledgeDocDoc["facets"];
  source: KnowledgeDocDoc["source"];
  /** Text relevance, for a text query; null for a structured one. */
  score: number | null;
}

/** The query as a MongoDB filter — exposed so the read models share one meaning. */
export function filterOf(q: KnowledgeQuery): Filter<KnowledgeDocDoc> {
  const f: Record<string, unknown> = {};
  if (q.kinds !== undefined) f["kind"] = { $in: q.kinds };
  if (q.symbols !== undefined) f["facets.symbols"] = { $in: q.symbols };
  if (q.patterns !== undefined) f["facets.patterns"] = { $in: q.patterns };
  if (q.strategies !== undefined)
    f["facets.strategies"] = { $in: q.strategies };
  if (q.regimes !== undefined) f["facets.regimes"] = { $in: q.regimes };
  if (q.outcome !== undefined) f["facets.outcome"] = q.outcome;
  const toDate: Record<string, string> = {};
  if (q.fromDate !== undefined) toDate["$gte"] = q.fromDate;
  if (q.asOf !== undefined) toDate["$lte"] = q.asOf;
  if (Object.keys(toDate).length > 0) f["subject.toDate"] = toDate;
  if (q.toDate !== undefined) f["subject.fromDate"] = { $lte: q.toDate };
  return f;
}

/**
 * Search the knowledge base (Phase 10 D4): structured, or text ranked by
 * relevance with ties broken by date then id — the same query always returns
 * the same list. Never past `asOf` (D5).
 */
export async function searchKnowledge(
  db: Db,
  q: KnowledgeQuery,
): Promise<KnowledgeHit[]> {
  const limit = Math.min(Math.max(1, q.limit ?? 20), MAX_RESULTS);
  const repo = new DocumentsRepository(db);
  const filter = filterOf(q);
  const docs =
    q.text === undefined || q.text.trim() === ""
      ? (await repo.find(filter, limit)).map((d) => ({ ...d, score: null }))
      : await repo.search(q.text, filter, limit);
  return docs.map((d) => ({
    docId: d.docId,
    kind: d.kind,
    title: d.title,
    text: d.text,
    subject: d.subject,
    facets: d.facets,
    source: d.source,
    score: d.score,
  }));
}
