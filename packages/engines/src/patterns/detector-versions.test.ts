import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, type Candle } from "@neelkanth/core";
import { BUILTIN_DETECTORS, createPatternRegistry } from "@neelkanth/patterns";
import { sweepPatterns } from "./pattern-sweep.js";

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

/**
 * Three sessions, REAL volume, every detector firing at least once.
 *
 * Integer arithmetic only — two triangle waves and an LCG, in paise — so the
 * series is bit-identical on every runtime. `Math.sin` is not required to
 * be, and a pin that drifted with the platform would teach people to ignore
 * it.
 */
function series(): Candle[] {
  const opens = [
    Date.UTC(2026, 0, 5, 3, 45),
    Date.UTC(2026, 0, 6, 3, 45),
    Date.UTC(2026, 0, 7, 3, 45),
  ];
  const triangle = (i: number, period: number, amplitude: number): number => {
    const phase = i % period;
    const half = period / 2;
    return Math.round(
      ((phase < half ? phase : period - phase) / half) * 2 * amplitude -
        amplitude,
    );
  };
  let seed = 12345;
  const noise = (span: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed % (2 * span + 1)) - span;
  };
  const candles: Candle[] = [];
  let i = 0;
  for (const open of opens) {
    for (let k = 0; k < 75; k += 1, i += 1) {
      const mid = 10_000 + triangle(i, 44, 600) + triangle(i, 14, 250) + 2 * k;
      const o = mid + noise(40);
      const close = mid + noise(80);
      candles.push({
        symbol: "NSE:PIN-EQ",
        interval: "5m",
        source: "BROKER_HISTORICAL",
        open: o / 100,
        high: (Math.max(o, close) + 40) / 100,
        low: (Math.min(o, close) - 40) / 100,
        close: close / 100,
        // Every fifth bar a ladder spanning the 1.5x threshold (about 1.3x to
        // 1.65x the average), so a moved threshold moves what is detected.
        volume: i % 5 === 0 ? 1_800 + (i % 7) * 80 : 1_000 + ((i * 37) % 500),
        volumeAvailable: true,
        volumeQuality: "REAL",
        ts: open + k * 300_000,
      });
    }
  }
  return candles;
}

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
