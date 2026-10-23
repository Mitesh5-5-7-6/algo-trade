import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@neelkanth/core";

/** Bumped whenever what a document holds, or how it is rendered, changes (Phase 10 D3). */
export const KNOWLEDGE_INDEX_VERSION = "2";

/**
 * What a document is about. One per kind of research item; backtests,
 * walk-forward results, news and AI analysis join when they exist.
 */
export const KnowledgeKindSchema = z.enum([
  "DAY",
  "TRADE",
  "CHART",
  "WINDOW",
  "COUNTERFACTUAL",
  "HYPOTHESIS",
  "FINDING",
  "DETECTOR",
]);
export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>;

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The evidence a document indexes (Phase 10 D1): the document is never it. */
export const SourceRefSchema = z.object({
  collection: z.string().min(1),
  id: z.string().min(1),
  /** The source's version, where it has one (reports); null where it is insert-once. */
  version: z.number().int().positive().nullable(),
  fingerprint: z.string().min(1),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const KnowledgeDocumentSchema = z
  .object({
    /** `KIND|source id|part` — stable, so a re-index finds the same document. */
    docId: z.string().min(1),
    kind: KnowledgeKindSchema,
    source: SourceRefSchema,
    /** The period the research is about — what `asOf` is judged against (D5). */
    subject: z.object({ fromDate: DateSchema, toDate: DateSchema }),
    /** What a document is queried by (D4). Lists sorted and unique. */
    facets: z.object({
      symbols: z.array(z.string()),
      patterns: z.array(z.string()),
      strategies: z.array(z.string()),
      regimes: z.array(z.string()),
      /** WIN / LOSS / FLAT for a Trade; a verdict for a finding. */
      outcome: z.string().optional(),
      /** The sample behind the document's numbers, where it has one. */
      n: z.number().int().nonnegative().optional(),
      period: z.string().optional(),
    }),
    title: z.string().min(1),
    text: z.string().min(1),
    indexVersion: z.string().min(1),
    /** sha256 of everything above except the index version — what a re-index compares. */
    contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .superRefine((d, ctx) => {
    if (d.subject.fromDate > d.subject.toDate)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject"],
        message: "a subject ends on or after it starts",
      });
    const problem = contextProblem(d.text);
    if (problem !== null)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: problem,
      });
  });
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;

/**
 * D2: a document's text never states a result without its context — the
 * Phase 7 rule (D7) for every document. Where it speaks of a rate, an
 * expectancy, a win or a loss, it must say how many (`n = `) and when (a
 * date). Returns what is missing, or null.
 */
export function contextProblem(text: string): string | null {
  const claims =
    /%|\bwin rate\b|\bexpectancy\b|\bnet\b|\bwins?\b|\blos(s|ses|t)\b/i.test(
      text,
    );
  if (!claims) return null;
  if (!/\bn = \d+/.test(text))
    return "a result is stated without its sample size (n = …)";
  if (!/\d{4}-\d{2}-\d{2}/.test(text))
    return "a result is stated without its date";
  return null;
}

const uniqueSorted = (xs: Iterable<string>): string[] =>
  [...new Set(xs)].sort();

/** Build a document: facets normalised, fingerprinted, and validated — context included. */
export function makeDocument(
  fields: Omit<KnowledgeDocument, "indexVersion" | "contentFingerprint">,
): KnowledgeDocument {
  const facets = {
    ...fields.facets,
    symbols: uniqueSorted(fields.facets.symbols),
    patterns: uniqueSorted(fields.facets.patterns),
    strategies: uniqueSorted(fields.facets.strategies),
    regimes: uniqueSorted(fields.facets.regimes),
  };
  const body = { ...fields, facets };
  return KnowledgeDocumentSchema.parse({
    ...body,
    indexVersion: KNOWLEDGE_INDEX_VERSION,
    contentFingerprint: createHash("sha256")
      .update(canonicalJson(body))
      .digest("hex"),
  });
}
