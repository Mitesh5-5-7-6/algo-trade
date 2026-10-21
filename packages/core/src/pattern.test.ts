import { describe, expect, it } from "vitest";
import { canonicalJson } from "./strategy-version.js";
import { patternParamsKey, toObservation } from "./pattern.js";

/**
 * A params key is the strategy version's and the replay fingerprint's
 * serialisation (Phase 5 audit §2.2 point 2). Two copies can drift — and a
 * drifted key would split one parameter set into two samples, or merge two.
 */
describe("patternParamsKey", () => {
  it("is canonicalJson of the parameters", () => {
    const params = { slow: 21, fast: 9, nested: { b: 2, a: [3, 1] } };
    expect(patternParamsKey(params)).toBe(canonicalJson(params));
    expect(patternParamsKey(params)).toBe(
      '{"fast":9,"nested":{"a":[3,1],"b":2},"slow":21}',
    );
  });

  it("does not depend on the order the parameters were written in", () => {
    expect(patternParamsKey({ fast: 9, slow: 21 })).toBe(
      patternParamsKey({ slow: 21, fast: 9 }),
    );
    expect(patternParamsKey({ fast: 9, slow: undefined })).toBe(
      patternParamsKey({ fast: 9 }),
    );
  });

  it("refuses a key too long for the identity index", () => {
    expect(() =>
      patternParamsKey({
        levels: Array.from({ length: 200 }, (_, i) => i * 1000),
      }),
    ).toThrow(/too long/);
  });
});

describe("toObservation", () => {
  it("adds the params key and when it was observed", () => {
    const observation = toObservation(
      {
        patternId: "EMA_CROSS",
        detectorVersion: "1.0.0",
        symbol: "NSE:X-EQ",
        interval: "5m",
        ts: 1_000,
        direction: "BULLISH",
        evidence: { fast: 101 },
        params: { slow: 21, fast: 9 },
      },
      2_000,
    );
    expect(observation).toMatchObject({
      paramsKey: '{"fast":9,"slow":21}',
      observedAt: 2_000,
    });
  });
});
