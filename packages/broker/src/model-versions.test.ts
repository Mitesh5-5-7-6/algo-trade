import { describe, expect, it } from "vitest";
import {
  CHARGES_MODEL_VERSION,
  computeCharges,
  DEFAULT_CHARGES,
} from "./charges.js";
import { applySlippage, SLIPPAGE_MODEL_VERSION } from "./slippage.js";

/**
 * Task 4.5, design Q3: every replay names the cost and slippage models it was
 * measured with, so their versions must mean something.
 *
 * Each version pins the model's outputs on fixed inputs. Change the
 * arithmetic and the pin for the current version fails — the fix is to add
 * the new outputs under a NEW version, which is exactly the bump that keeps
 * two replays measured differently from claiming the same model.
 */
const CHARGES_PINNED: Record<string, number[]> = {
  "1": [0.420226, 0.640226, 30.2226, 52.2226],
};
const SLIPPAGE_PINNED: Record<string, number[]> = {
  "1": [100.05, 99.95, 100.05, 100],
};

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

describe("model versions are pinned to their arithmetic (§4.5, Q3)", () => {
  it("transaction costs", () => {
    const outputs = (
      [
        [100, 10, "BUY"],
        [100, 10, "SELL"],
        [2500, 40, "BUY"],
        [2500, 40, "SELL"],
      ] as const
    ).map(([price, qty, side]) =>
      r6(computeCharges(price, qty, side, DEFAULT_CHARGES)),
    );
    expect(outputs).toEqual(CHARGES_PINNED[CHARGES_MODEL_VERSION]);
  });

  it("slippage", () => {
    const outputs = [
      applySlippage(100, "BUY", { kind: "percent", pct: 0.0005 }),
      applySlippage(100, "SELL", { kind: "percent", pct: 0.0005 }),
      applySlippage(100, "BUY", { kind: "fixed", amount: 0.05 }),
      applySlippage(100, "SELL", { kind: "none" }),
    ].map(r6);
    expect(outputs).toEqual(SLIPPAGE_PINNED[SLIPPAGE_MODEL_VERSION]);
  });
});
