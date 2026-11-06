import type { Notification } from "./notifier.js";

/**
 * The research and lifecycle catalogue (Phase 16, task 16.9; design §5.1
 * D10): one message per thing a CLI has kept. All INFO, all in the
 * operations chat — research is not a trade (D8, Q3). Only what exists is
 * here; promotion arrives with Phase 15, and a "finding" or an
 * "improvement" once either is defined.
 */

const inr = (value: number): string =>
  `${value < 0 ? "-" : ""}₹${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const info = (
  mode: Notification["mode"],
  title: string,
  body: string,
): Notification => ({
  severity: "INFO",
  mode,
  title,
  body,
  chat: "operations",
});

/** `validation.mts declare`: a candidate, from its hypothesis. */
export function candidateDeclared(c: {
  readonly candidateId: string;
  readonly strategyType: string;
  readonly grid: readonly unknown[];
  readonly symbols: readonly string[];
  readonly hypothesisId: string;
  readonly statement: string;
}): Notification {
  return info(
    "research",
    `Candidate declared: ${c.candidateId} (${c.strategyType})`,
    `${String(c.grid.length)} variants on ${c.symbols.join(", ")}, from ${c.hypothesisId}: ${c.statement}`,
  );
}

/** `validation.mts walk-forward`, kept: the gate's verdict on it. */
export function walkForwardJudged(w: {
  readonly candidateId: string;
  readonly walkForwardId: string;
  readonly folds: number;
  readonly verdict: "PASS" | "FAIL";
  readonly failed: readonly string[];
  readonly trades: number;
  readonly expectancy: number | null;
}): Notification {
  return info(
    "research",
    `Walk-forward ${w.verdict}: ${w.candidateId}`,
    `${w.walkForwardId}, ${String(w.folds)} folds, ${String(w.trades)} out-of-sample trades, ${w.expectancy === null ? "no expectancy" : `${inr(w.expectancy)} per trade`}${w.failed.length > 0 ? `. Failed: ${w.failed.join(", ")}` : ""}`,
  );
}

/** `paper.mts report`, kept: one paper session's report. */
export function paperSessionReported(r: {
  readonly session: string;
  readonly reportId: string;
  readonly clean: boolean;
  readonly closedTrades: number;
  readonly net: number;
  readonly differences: number;
}): Notification {
  return info(
    "paper",
    `Paper session ${r.session}: ${r.clean ? "CLEAN" : "NOT CLEAN"}`,
    `${String(r.closedTrades)} trades, net ${inr(r.net)}, ${String(r.differences)} parity differences. ${r.reportId}`,
  );
}

/**
 * `periodic-research.mts`: the weekly reports it kept for the first time —
 * one message however many, so a backfill is not a flood. Null when none.
 * `reported` holds `<windowId>|v<n>`; a week's id is `YYYY-Www`.
 */
export function weeklyReported(
  reported: readonly string[],
): Notification | null {
  const weeks = reported
    .map((r) => r.split("|"))
    .filter(([id, v]) => /^\d{4}-W\d{2}$/.test(id ?? "") && v === "v1")
    .map(([id]) => id ?? "");
  if (weeks.length === 0) return null;
  return info(
    "research",
    weeks.length === 1
      ? `Weekly report: ${weeks[0] ?? ""}`
      : `${String(weeks.length)} weekly reports`,
    weeks.join(", "),
  );
}
