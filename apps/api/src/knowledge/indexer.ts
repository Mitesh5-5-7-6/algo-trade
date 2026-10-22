import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { canonicalJson } from "@neelkanth/core";
import {
  DocumentsRepository,
  PatternCatalogRepository,
  ResearchReportsRepository,
  StrategyExperimentsRepository,
} from "@neelkanth/db";
import type { KnowledgeDocument } from "./document.js";
import {
  renderCounterfactual,
  renderDailyReport,
  renderDetector,
  renderHypotheses,
  renderWindowReport,
} from "./render.js";

export interface IndexOutcome {
  added: number;
  replaced: number;
  unchanged: number;
  /** Documents no source produces any more — a Trade gone after a revision. */
  removed: number;
  byKind: Record<string, number>;
}

const EVERYTHING = { from: "0001-01-01", to: "9999-12-31" };

/**
 * Every document the research database's current records produce (Phase 10
 * D1): the newest version of every report, every experiment, hypothesis and
 * test, every detector definition.
 */
export async function renderAll(db: Db): Promise<KnowledgeDocument[]> {
  const reports = new ResearchReportsRepository(db);
  const experiments = new StrategyExperimentsRepository(db);
  const docs: KnowledgeDocument[] = [];
  for (const d of await reports.latestInRange(
    "DAY",
    EVERYTHING.from,
    EVERYTHING.to,
  ))
    docs.push(...renderDailyReport(d));
  for (const period of ["WEEK", "MONTH", "QUARTER"] as const)
    for (const d of await reports.latestInRange(
      period,
      EVERYTHING.from,
      EVERYTHING.to,
    ))
      docs.push(...renderWindowReport(d));
  for (const d of await experiments.listByKind("COUNTERFACTUAL"))
    docs.push(...renderCounterfactual(d));
  docs.push(
    ...renderHypotheses(
      await experiments.listByKind("HYPOTHESIS"),
      await experiments.listByKind("HYPOTHESIS_TEST"),
    ),
  );
  for (const def of await new PatternCatalogRepository(db).list())
    docs.push(
      ...renderDetector(
        def,
        createHash("sha256").update(canonicalJson(def)).digest("hex"),
      ),
    );
  return docs;
}

/**
 * Index the research database (Phase 10 D3): every document its current
 * records produce is added, replaced when its content or source moved, or
 * left unchanged; every document no record produces any more is removed.
 * Idempotent — a second run changes nothing. Reads the research
 * collections; writes `documents` only.
 */
export async function indexResearch(db: Db): Promise<IndexOutcome> {
  const repo = new DocumentsRepository(db);
  const docs = await renderAll(db);
  const ids = new Set<string>();
  const outcome: IndexOutcome = {
    added: 0,
    replaced: 0,
    unchanged: 0,
    removed: 0,
    byKind: {},
  };
  // One read of what is kept, a local comparison, one write of what moved:
  // a year's index is thousands of documents, and a round trip each is the
  // remote cluster's exposure the sign-offs kept paying for (Phase 9).
  const kept = await repo.fingerprints();
  const changed: KnowledgeDocument[] = [];
  for (const doc of docs) {
    if (ids.has(doc.docId)) throw new Error(`two sources render ${doc.docId}`);
    ids.add(doc.docId);
    outcome.byKind[doc.kind] = (outcome.byKind[doc.kind] ?? 0) + 1;
    const was = kept.get(doc.docId);
    if (was === undefined) outcome.added += 1;
    else if (was !== `${doc.indexVersion}|${doc.contentFingerprint}`)
      outcome.replaced += 1;
    else {
      outcome.unchanged += 1;
      continue;
    }
    changed.push(doc);
  }
  await repo.replaceMany(changed);
  outcome.removed = await repo.remove(
    [...kept.keys()].filter((id) => !ids.has(id)),
  );
  outcome.byKind = Object.fromEntries(
    Object.entries(outcome.byKind).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return outcome;
}
