import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@neelkanth/core";
import { BUILTIN_DETECTORS, createPatternRegistry } from "@neelkanth/patterns";
import { sweepPatterns } from "./pattern-sweep.js";
import { fixedSeries as series } from "./test-support/fixed-series.js";

/**
 * Phase 5 D5 — a detector's version means its arithmetic (spec §5.1).
 *
 * Each built-in detector, at its default parameters, is swept over one fixed
 * series and what it found is pinned beside the version it found it under.
 * Change what a detector detects without bumping `detectorVersion` and its
 * pin fails; observations stored under the old rule would otherwise be
 * pooled, silently, with ones the new rule produced.
 *
 * To change a rule: bump the detector's `detectorVersion`, then update its
 * pin to the new output. Changing one without the other is the bug.
 */
const PINS: Record<
  string,
  { version: string; count: number; outputs: string }
> = {
  ORB_BREAKOUT: {
    version: "1.0.0",
    count: 12,
    outputs: "d19505622d30ca37d41be10e34a65336296e5fd6fe053c1efc8af2377a1b07aa",
  },
  EMA_CROSS: {
    version: "1.0.0",
    count: 9,
    outputs: "5d3875c2c5f9f3fbc2bc16ae3454cb515082d4af9c92c67b96f675f59af0fc0e",
  },
  RSI_REVERSION: {
    version: "1.0.0",
    count: 12,
    outputs: "68c4a06f5027b052a1d090ce65eefb40d9d500b4cd75986ebe71f75af6d44b46",
  },
  VWAP_RECLAIM: {
    version: "1.0.0",
    count: 22,
    outputs: "d7c5dfbc7e8b315e136726e567be21e72c7289dd853b0e20a3839e82161e4282",
  },
  HIGH_VOLUME_BREAKOUT: {
    version: "1.0.0",
    count: 5,
    outputs: "2eae022073aa4bc036c14f697615769785d673b3afe9adc264019cb27262b2e8",
  },
};

function outputsOf(patternId: string) {
  const registry = createPatternRegistry();
  const { occurrences } = sweepPatterns({
    symbol: "NSE:PIN-EQ",
    interval: "5m",
    candles: series(),
    detectors: [registry.instantiate(patternId)],
  });
  const found = occurrences.map((o) => ({
    ts: o.ts,
    direction: o.direction,
    evidence: o.evidence,
  }));
  return {
    count: found.length,
    outputs: createHash("sha256").update(canonicalJson(found)).digest("hex"),
  };
}

describe("detector versions are pinned to what they detect (D5)", () => {
  it("pins every built-in detector, and nothing else", () => {
    expect(Object.keys(PINS).sort()).toEqual(
      BUILTIN_DETECTORS.map((d) => d.patternId).sort(),
    );
  });

  for (const detector of BUILTIN_DETECTORS) {
    it(`${detector.patternId}: what it detects matches its version's pin`, () => {
      const pin = PINS[detector.patternId];
      // A pin that saw nothing would pin nothing.
      expect(pin?.count).toBeGreaterThan(0);
      expect(
        { version: detector.detectorVersion, ...outputsOf(detector.patternId) },
        `${detector.patternId} changed: bump detectorVersion and re-pin, or undo the change`,
      ).toEqual(pin);
    });
  }

  /** Same series, same answer — or the pin itself would be noise. */
  it("is deterministic", () => {
    for (const d of BUILTIN_DETECTORS)
      expect(outputsOf(d.patternId)).toEqual(outputsOf(d.patternId));
  });
});
