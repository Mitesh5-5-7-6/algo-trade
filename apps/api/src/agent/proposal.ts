import { checkAnswer, type ToolCall } from "./answer.js";
import type { Proposal } from "./proposal-schema.js";

/** At most this many proposals in one answer (D1). */
export const MAX_PROPOSALS = 5;

export { ProposalSchema, type Proposal } from "./proposal-schema.js";

/**
 * What a proposal may name (D3): the detectors, the strategies the
 * counterfactual can replay on these instruments, the instruments researched,
 * and the strategy's own parameter check.
 */
export interface ProposalCatalog {
  patterns: readonly string[];
  strategies: readonly string[];
  symbols: readonly string[];
  /** The strategy's own schema's complaint about these parameters, or null. */
  checkParams: (
    strategyType: string,
    params: Record<string, unknown>,
  ) => string | null;
}

export interface ProposalCheck {
  index: number;
  statement: string;
  problems: string[];
}

/** A variant's parameters as the strategy reads them. */
export const paramsOf = (p: Proposal): Record<string, unknown> =>
  Object.fromEntries(p.strategyParams.map((x) => [x.name, x.value]));

/**
 * Check a proposal before it can ever be registered (D3). Deterministic: the
 * same proposal, calls and catalog always give the same problems.
 */
export function checkProposal(
  p: Proposal,
  index: number,
  calls: readonly ToolCall[],
  asOf: string,
  catalog: ProposalCatalog,
): ProposalCheck {
  const problems: string[] = [];
  const { cell } = p;
  if (cell.patternId !== "ALL" && !catalog.patterns.includes(cell.patternId))
    problems.push(
      `pattern ${cell.patternId} is no detector — one of ${catalog.patterns.join(", ")}, or ALL`,
    );
  if (!catalog.strategies.includes(cell.strategyType))
    problems.push(
      `strategy ${cell.strategyType} cannot be replayed — one of ${catalog.strategies.join(", ")}`,
    );
  if (cell.symbol !== "ALL" && !catalog.symbols.includes(cell.symbol))
    problems.push(
      `symbol ${cell.symbol} is not researched — one of ${catalog.symbols.join(", ")}, or ALL`,
    );
  if (p.metric === "winRate" && (p.threshold < 0 || p.threshold > 1))
    problems.push(
      `a win-rate threshold is a probability, 0 to 1 — not ${String(p.threshold)}`,
    );
  const names = p.strategyParams.map((x) => x.name);
  if (new Set(names).size !== names.length)
    problems.push("a parameter is named twice");
  if (
    p.strategyParams.length > 0 &&
    catalog.strategies.includes(cell.strategyType)
  ) {
    const complaint = catalog.checkParams(cell.strategyType, paramsOf(p));
    if (complaint !== null)
      problems.push(
        `the variant is not a valid ${cell.strategyType}: ${complaint}`,
      );
  }
  // The rationale is evidence, checked as any claim is (Phase 11 D3).
  const byId = new Map(calls.map((c) => [c.id, c]));
  if (
    !p.rationale.some((r) =>
      r.cites.some((id) => {
        const c = byId.get(id);
        return c?.outcome.ok === true && c.outcome.evidence;
      }),
    )
  )
    problems.push(
      "the rationale cites no evidence tool — a proposal must rest on evidence, not memory",
    );
  const rationale = checkAnswer(
    { summary: "", claims: p.rationale, caveats: [] },
    calls,
    asOf,
  );
  for (const c of rationale.claims)
    for (const problem of c.problems)
      problems.push(`rationale ${String(c.index + 1)}: ${problem}`);
  return { index, statement: p.statement, problems };
}

/** Every proposal of an answer, and the answer-level rule: at most five. */
export function checkProposals(
  proposals: readonly Proposal[],
  calls: readonly ToolCall[],
  asOf: string,
  catalog: ProposalCatalog,
): { ok: boolean; problems: string[]; proposals: ProposalCheck[] } {
  const problems =
    proposals.length > MAX_PROPOSALS
      ? [
          `${String(proposals.length)} proposals — at most ${String(MAX_PROPOSALS)}; keep the ones the evidence supports best`,
        ]
      : [];
  const checks = proposals.map((p, i) =>
    checkProposal(p, i, calls, asOf, catalog),
  );
  return {
    ok: problems.length === 0 && checks.every((c) => c.problems.length === 0),
    problems,
    proposals: checks,
  };
}
