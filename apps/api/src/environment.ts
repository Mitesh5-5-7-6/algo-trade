/**
 * Which databases each trading mode may run on (Phase 14 D2, ADR §8).
 *
 * Paper and Live own separate databases. Until this check, nothing tied the
 * mode to one: a paper process pointed at the research or the live database
 * would have written paper orders, positions and Trades beside real ones,
 * told apart by a field. Now the process refuses to start.
 */
const PAPER = /^neelkanth_paper(_[a-z0-9_]+)?$/;
/** The isolated databases integration suites create and drop. */
const TEST = /^neelkanth_(it|ci)_[a-z0-9_]+$/;
const RESEARCH = /^neelkanth_research$/;

/** Why `mode` may not run on `database` — or null when it may. */
export function modeDatabaseProblem(
  mode: "paper" | "live",
  database: string,
): string | null {
  if (mode === "paper")
    return PAPER.test(database) || TEST.test(database)
      ? null
      : `paper mode runs only on a paper database (neelkanth_paper, or neelkanth_paper_<name> for a drill) — not "${database}" (ADR §8, Phase 14 D2)`;
  if (PAPER.test(database))
    return `live mode refuses "${database}": it is a paper database (ADR §8)`;
  if (RESEARCH.test(database))
    return `live mode refuses "${database}": it is the research database (ADR §8)`;
  if (TEST.test(database))
    return `live mode refuses "${database}": it is an integration-test database`;
  return null;
}
