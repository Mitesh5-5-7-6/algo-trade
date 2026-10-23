import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { canonicalJson } from "@neelkanth/core";
import {
  StrategyCandidatesRepository,
  StrategyExperimentsRepository,
  type StrategyCandidateDoc,
} from "@neelkanth/db";
import { variantProblem } from "../agent/catalog.js";
import { strategyEligibility } from "../counterfactual/eligibility.js";
import { HypothesisSchema } from "../validation/hypothesis.js";

/** The most variants a walk-forward may choose among (D1). */
export const MAX_GRID = 12;

export interface CandidateDeclaration {
  strategyType: string;
  grid: Record<string, unknown>[];
  symbols: string[];
  hypothesisId: string;
  statement: string;
}

/**
 * What is wrong with a declaration, before it is kept (D1): the strategy
 * must be replayable on every instrument; the grid one to twelve distinct
 * variants, each taken by the strategy's own schema exactly as given.
 */
export function declarationProblems(d: CandidateDeclaration): string[] {
  const problems: string[] = [];
  if (d.symbols.length === 0)
    problems.push("a candidate names its instruments");
  const held = new Set(d.symbols);
  for (const symbol of d.symbols) {
    const row = strategyEligibility(symbol, "5m", held).find(
      (e) => e.type === d.strategyType,
    );
    if (row === undefined) problems.push(`${d.strategyType} is no strategy`);
    else if (!row.eligible)
      problems.push(
        `${d.strategyType} cannot be replayed on ${symbol}: ${row.exclusion?.reason ?? "excluded"}`,
      );
  }
  if (d.grid.length === 0 || d.grid.length > MAX_GRID)
    problems.push(
      `a grid holds 1 to ${String(MAX_GRID)} variants — not ${String(d.grid.length)}`,
    );
  const seen = new Set<string>();
  d.grid.forEach((params, i) => {
    const key = canonicalJson(params);
    if (seen.has(key))
      problems.push(`variant ${String(i + 1)} repeats another`);
    seen.add(key);
    if (Object.keys(params).length > 0) {
      const problem = variantProblem(d.strategyType, params);
      if (problem !== null)
        problems.push(`variant ${String(i + 1)}: ${problem}`);
    }
  });
  return [...new Set(problems)];
}

const fingerprintOf = (d: CandidateDeclaration): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        strategyType: d.strategyType,
        grid: d.grid,
        symbols: [...d.symbols].sort(),
        hypothesisId: d.hypothesisId,
      }),
    )
    .digest("hex");

/** The next free candidate id. */
export function nextCandidateId(existing: readonly string[]): string {
  const max = existing.reduce((m, id) => {
    const n = Number(/^SC-(\d+)$/.exec(id)?.[1] ?? 0);
    return n > m ? n : m;
  }, 0);
  return `SC-${String(max + 1).padStart(4, "0")}`;
}

/**
 * Declare a candidate (Phase 13 D1) — the operator's act. Refused for an
 * unregistered hypothesis (spec §5.2), a hypothesis about another strategy,
 * a declaration with problems, or one already declared. Kept once, never
 * edited: the grid is fixed before any walk-forward runs.
 */
export async function declareCandidate(
  db: Db,
  d: CandidateDeclaration,
  createdAt: number,
): Promise<StrategyCandidateDoc> {
  const doc = await new StrategyExperimentsRepository(db).findById(
    d.hypothesisId,
  );
  if (doc?.kind !== "HYPOTHESIS")
    throw new Error(
      `${d.hypothesisId} is not a registered hypothesis — a candidate cannot come from an unregistered one (spec §5.2)`,
    );
  const h = HypothesisSchema.parse(doc.manifest);
  if (h.cell.strategyType !== d.strategyType)
    throw new Error(
      `${d.hypothesisId} is about ${h.cell.strategyType}, not ${d.strategyType}`,
    );
  const problems = declarationProblems(d);
  if (problems.length > 0)
    throw new Error(`the candidate is refused: ${problems.join("; ")}`);
  const repo = new StrategyCandidatesRepository(db);
  const fingerprint = fingerprintOf(d);
  const same = await repo.findByFingerprint(fingerprint);
  if (same.length > 0)
    throw new Error(
      `this candidate is already declared as ${same.map((c) => c.candidateId).join(", ")}`,
    );
  const candidate: StrategyCandidateDoc = {
    candidateId: nextCandidateId((await repo.list()).map((c) => c.candidateId)),
    createdAt,
    strategyType: d.strategyType,
    grid: d.grid,
    symbols: [...d.symbols].sort(),
    hypothesisId: d.hypothesisId,
    statement: d.statement,
    fingerprint,
  };
  if (!(await repo.save(candidate)))
    throw new Error(`${candidate.candidateId} is already declared`);
  return candidate;
}
