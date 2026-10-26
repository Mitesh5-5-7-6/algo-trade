import type { WalkForwardResult } from "./walk-forward.js";

/** Bumped whenever a criterion or threshold changes (Phase 13 D6). */
export const VALIDATION_GATE_VERSION = "1";

/** The standard gate (Q1). */
export const GATE = {
  minTrades: 30,
  alpha: 0.05,
  minProfitFactor: 1.1,
  maxDrawdownPct: 0.1,
} as const;

export interface Criterion {
  name: string;
  threshold: string;
  /** What the evidence shows, in words — "n/a" when there is nothing to judge. */
  value: string;
  held: boolean;
}

export interface ValidationVerdict {
  gateVersion: string;
  walkForwardFingerprint: string;
  verdict: "PASS" | "FAIL";
  criteria: Criterion[];
  /** The criteria that did not hold, by name. */
  failed: string[];
}

const show = (x: number | null, places = 2): string =>
  x === null ? "n/a" : x.toFixed(places);

/**
 * Judge a walk-forward against the standard gate (Phase 13 D6, Q1): out of
 * sample, across its folds, net of costs. PASS only if every criterion
 * holds; a criterion with nothing to judge — no Trades, no p — fails.
 * Deterministic and computed from the kept result, so a verdict can never
 * drift from the evidence it judges. PASS makes a candidate eligible for
 * paper validation; neither verdict changes any strategy.
 */
export function judge(wf: WalkForwardResult): ValidationVerdict {
  const { normal, stressed, baseline } = wf.outOfSample;
  const criteria: Criterion[] = [
    {
      name: "trades",
      threshold: `≥ ${String(GATE.minTrades)}`,
      value: String(normal.trades),
      held: normal.trades >= GATE.minTrades,
    },
    {
      name: "expectancy",
      threshold: `> 0, one-sided p < ${String(GATE.alpha)}`,
      value: `${show(normal.expectancy)} per Trade, p ${show(normal.expectancyPValue, 4)}`,
      held:
        normal.expectancy !== null &&
        normal.expectancy > 0 &&
        normal.expectancyPValue !== null &&
        normal.expectancyPValue < GATE.alpha,
    },
    {
      name: "profitFactor",
      threshold: `> ${String(GATE.minProfitFactor)}`,
      value:
        normal.profitFactor === null
          ? normal.wins > 0
            ? "no losing Trade"
            : "n/a"
          : show(normal.profitFactor),
      // No losing Trade is the best a profit factor can be — when there were wins.
      held:
        normal.profitFactor === null
          ? normal.wins > 0
          : normal.profitFactor > GATE.minProfitFactor,
    },
    {
      name: "maxDrawdown",
      threshold: `≤ ${String(GATE.maxDrawdownPct * 100)}% of capital`,
      value: `${show(normal.maxDrawdownPct * 100)}% (${show(normal.maxDrawdown)})`,
      held: normal.trades > 0 && normal.maxDrawdownPct <= GATE.maxDrawdownPct,
    },
    {
      name: "stressedExpectancy",
      threshold: "> 0 with slippage ×2 and charges ×1.5",
      value: `${show(stressed.expectancy)} per Trade`,
      held: stressed.expectancy !== null && stressed.expectancy > 0,
    },
    {
      name: "againstBaseline",
      threshold: "expectancy ≥ the configured strategy's, same windows",
      value: `${show(normal.expectancy)} against ${show(baseline.expectancy)}`,
      // A baseline that took no Trade sets no bar.
      held:
        normal.expectancy !== null &&
        (baseline.expectancy === null ||
          normal.expectancy >= baseline.expectancy),
    },
  ];
  const failed = criteria.filter((c) => !c.held).map((c) => c.name);
  return {
    gateVersion: VALIDATION_GATE_VERSION,
    walkForwardFingerprint: wf.fingerprint,
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    criteria,
    failed,
  };
}
