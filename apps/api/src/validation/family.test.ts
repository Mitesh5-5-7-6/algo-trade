import { describe, expect, it } from "vitest";
import type { HypothesisTest, WindowEvaluation } from "./gate.js";
import { hypothesisFingerprint, type Hypothesis } from "./hypothesis.js";
import { describeFinding, familyFindings, FindingSchema } from "./family.js";
import { hypothesis } from "./test-support.js";

/**
 * Task 7.5 (design D6, D7): a family is corrected together, and a finding
 * cannot be said without its context.
 */
const member = (id: string, over: Partial<Hypothesis> = {}): Hypothesis =>
  hypothesis({ hypothesisId: id, family: "F-1", ...over });

function window(over: Partial<WindowEvaluation> = {}): WindowEvaluation {
  return {
    dateRange: { fromDate: "2026-03-30", toDate: "2026-09-28" },
    n: 100,
    estimate: -40,
    interval: { lower: -70, upper: -10 },
    pValue: 0.01,
    verdict: "SUPPORTED",
    charges: 500,
    slippage: 250,
    net: -4000,
    runFingerprint: "f".repeat(64),
    ...over,
  };
}
function test(h: Hypothesis, oos: Partial<WindowEvaluation>): HypothesisTest {
  return {
    hypothesisId: h.hypothesisId,
    hypothesisFingerprint: hypothesisFingerprint(h),
    family: h.family,
    testedAt: 2_000,
    gatePolicyVersion: "1",
    outOfSample: window(oos),
    inSample: window({ n: 120, estimate: -55, verdict: "SUPPORTED" }),
  };
}

describe("a family is corrected together (7.5, D6)", () => {
  /** R: p.adjust(c(.01, .04, .03), "holm") = .03 .06 .06. */
  it("applies Holm across the family; only claims that survive it are supported", () => {
    const hs = [
      member("H-0001"),
      member("H-0002", { threshold: -1 }),
      member("H-0003", { threshold: -2 }),
    ];
    const ts = [
      test(hs[0] as Hypothesis, { pValue: 0.01 }),
      test(hs[1] as Hypothesis, { pValue: 0.04 }),
      test(hs[2] as Hypothesis, { pValue: 0.03 }),
    ];
    const f = familyFindings(hs, ts);
    expect(f.map((x) => x.rawVerdict)).toEqual([
      "SUPPORTED",
      "SUPPORTED",
      "SUPPORTED",
    ]);
    expect(f.map((x) => x.adjustedPValue)).toEqual([0.03, 0.06, 0.06]);
    expect(f.map((x) => x.verdict)).toEqual([
      "SUPPORTED",
      "NOT_SUPPORTED",
      "NOT_SUPPORTED",
    ]);
    expect(f.every((x) => x.familySize === 3)).toBe(true);
  });

  /** Registering three and testing the promising two buys nothing. */
  it("counts every registered member, tested or not, and too-small samples as p = 1", () => {
    const hs = [
      member("H-0001"),
      member("H-0002", { threshold: -1 }),
      member("H-0003", { threshold: -2 }),
      member("H-0004", { threshold: -3 }),
    ];
    const ts = [
      test(hs[0] as Hypothesis, { pValue: 0.012 }),
      test(hs[1] as Hypothesis, { pValue: 0.02 }),
      test(hs[2] as Hypothesis, {
        n: 12,
        pValue: null,
        interval: null,
        verdict: "INSUFFICIENT_SAMPLE",
      }),
    ];
    const f = familyFindings(hs, ts);
    // m = 4: .012×4 = .048, .02×3 = .06.
    expect(f.map((x) => x.verdict)).toEqual([
      "SUPPORTED",
      "NOT_SUPPORTED",
      "INSUFFICIENT_SAMPLE",
      "UNTESTED",
    ]);
    expect(f[0]?.adjustedPValue).toBeCloseTo(0.048, 12);
    expect(f[1]?.adjustedPValue).toBeCloseTo(0.06, 12);
    expect(f[2]?.adjustedPValue).toBeNull();
    expect(f[3]).toMatchObject({
      sampleSize: 0,
      adjustedPValue: null,
      inSample: null,
    });
  });

  it("refuses a hypothesis edited after its test, a second test, a stranger, and mixed alphas", () => {
    const h = member("H-0001");
    const t = test(h, {});
    expect(() => familyFindings([{ ...h, threshold: -99 }], [t])).toThrow(
      /edited after it was tested/,
    );
    expect(() => familyFindings([h], [t, t])).toThrow(/tested twice/);
    expect(() =>
      familyFindings([h], [{ ...t, hypothesisId: "H-0009" }]),
    ).toThrow(/does not hold/);
    expect(() =>
      familyFindings([h, member("H-0002", { alpha: 0.01 })], []),
    ).toThrow(/mixes alphas/);
    expect(() =>
      familyFindings([h, member("H-0002", { family: "F-2" })], []),
    ).toThrow(/family F-2/);
  });
});

describe("a finding cannot be said without its context (7.5, D7)", () => {
  const [finding] = familyFindings(
    [member("H-0001")],
    [test(member("H-0001"), {})],
  );

  it("says the number with its n, period, regime, costs, slippage, versions and out-of-sample status", () => {
    if (finding === undefined) throw new Error("no finding");
    const text = describeFinding(finding);
    for (const part of [
      "H-0001",
      "n = 100",
      "out of sample 2026-03-30 .. 2026-09-28",
      "regime ALL",
      "charges 500.00",
      "slippage 250.00",
      "Holm-adjusted",
      "family of 1",
      "strategy cfg-abc",
      "detector 1.0.0",
      "gate 1",
      "in sample: n = 120",
    ])
      expect(text).toContain(part);
  });

  /** "78% win rate", with nothing else, cannot be produced. */
  it("refuses a finding missing any part of its context", () => {
    if (finding === undefined) throw new Error("no finding");
    for (const key of [
      "sampleSize",
      "dateRange",
      "regime",
      "costs",
      "versions",
      "outOfSample",
      "instrumentCount",
      "familySize",
    ] as const) {
      const stripped = Object.fromEntries(
        Object.entries(finding).filter(([k]) => k !== key),
      );
      expect(() => describeFinding(stripped as typeof finding), key).toThrow();
    }
    expect(() =>
      describeFinding({ ...finding, outOfSample: false as unknown as true }),
    ).toThrow();
    expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it("says a too-small sample is not judged, and gives no rate a verdict", () => {
    const h = member("H-0001", {
      metric: "winRate",
      direction: "greater",
      threshold: 0.5,
    });
    const [small] = familyFindings(
      [h],
      [
        test(h, {
          n: 9,
          estimate: 0.78,
          interval: null,
          pValue: null,
          verdict: "INSUFFICIENT_SAMPLE",
        }),
      ],
    );
    if (small === undefined) throw new Error("no finding");
    const text = describeFinding(small);
    expect(text).toContain("INSUFFICIENT_SAMPLE");
    expect(text).toContain("n = 9 < 30 — not judged");
    expect(text).toContain("win rate 78.0%");
  });
});
