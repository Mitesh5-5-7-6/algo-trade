import { describe, expect, it } from "vitest";
import {
  binomialUpperTail,
  holmAdjust,
  meanInterval,
  meanPValue,
  normalCdf,
  normalQuantile,
  sampleStdDev,
  wilsonInterval,
} from "./stats.js";

/**
 * Task 7.1 (design D1): every primitive pinned against values computed
 * elsewhere — SciPy / R for the normal, statsmodels for Wilson, exact
 * arithmetic for the binomial, R's p.adjust for Holm.
 */
describe("the normal distribution", () => {
  it("Φ matches published values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 7);
    expect(normalCdf(-1)).toBeCloseTo(0.15865525393145707, 7);
    expect(normalCdf(3)).toBeCloseTo(0.9986501019683699, 7);
    expect(normalCdf(-4)).toBeCloseTo(3.167124183311992e-5, 9);
  });

  it("Φ⁻¹ matches published values, and inverts Φ", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 8);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269514722, 8);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232306167813, 7);
    for (const z of [-2.5, -0.3, 0.7, 2.2])
      expect(normalQuantile(normalCdf(z))).toBeCloseTo(z, 5);
    expect(() => normalQuantile(1)).toThrow();
  });
});

describe("Wilson score interval (statsmodels proportion_confint, method='wilson')", () => {
  const z = 1.959963984540054;
  it("8 of 10", () => {
    const i = wilsonInterval(8, 10, z);
    expect(i.lower).toBeCloseTo(0.4901624715, 6);
    expect(i.upper).toBeCloseTo(0.9433177546, 6);
  });
  /** Where the textbook interval collapses to a point, Wilson does not. */
  it("0 of 10 and 10 of 10", () => {
    expect(wilsonInterval(0, 10, z)).toMatchObject({ lower: 0 });
    expect(wilsonInterval(0, 10, z).upper).toBeCloseTo(0.2775327998, 6);
    expect(wilsonInterval(10, 10, z).lower).toBeCloseTo(0.7224672002, 6);
  });
});

describe("the exact binomial tail", () => {
  it("P(X ≥ 8 | 10, ½) = 56/1024, exactly", () => {
    expect(binomialUpperTail(8, 10, 0.5)).toBeCloseTo(56 / 1024, 12);
  });
  it("P(X ≥ 60 | 100, ½) matches R's 1 − pbinom(59, 100, .5)", () => {
    expect(binomialUpperTail(60, 100, 0.5)).toBeCloseTo(
      0.028443966820490392,
      10,
    );
  });
  it("holds in the thousands, and at the edges", () => {
    // Symmetry: P(X ≥ 1001 | 2000, ½) = (1 − P(X = 1000)) / 2.
    const atMode =
      binomialUpperTail(1000, 2000, 0.5) - binomialUpperTail(1001, 2000, 0.5);
    expect(binomialUpperTail(1001, 2000, 0.5)).toBeCloseTo(
      (1 - atMode) / 2,
      10,
    );
    expect(binomialUpperTail(0, 10, 0.3)).toBe(1);
    expect(binomialUpperTail(11, 10, 0.3)).toBe(0);
  });
});

describe("means", () => {
  it("sample standard deviation divides by n − 1", () => {
    expect(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(
      2.138089935299395,
      12,
    );
    expect(sampleStdDev([5])).toBe(0);
  });
  it("interval and one-sided p-value", () => {
    const i = meanInterval(10, 20, 100, 1.959963984540054);
    expect(i.lower).toBeCloseTo(6.0800720309, 8);
    expect(i.upper).toBeCloseTo(13.9199279691, 8);
    // z = (10 − 0) / (20 / 10) = 5.
    expect(meanPValue(10, 20, 100, 0, "greater")).toBeCloseTo(
      1 - 0.9999997133484281,
      9,
    );
    // z = (−3 − 0) / (30 / 10) = −1: P(Z ≤ −1).
    expect(meanPValue(-3, 30, 100, 0, "less")).toBeCloseTo(
      0.15865525393145707,
      7,
    );
    expect(meanPValue(-3, 30, 100, 0, "greater")).toBeCloseTo(
      0.8413447460685429,
      7,
    );
    expect(meanPValue(1, 0, 40, 0, "greater")).toBe(0);
  });
});

describe("Holm's correction (R: p.adjust(..., 'holm'))", () => {
  it("adjusts in input order and stays monotone", () => {
    const adj = holmAdjust([0.01, 0.04, 0.03, 0.005]);
    [0.03, 0.06, 0.06, 0.02].forEach((v, i) => {
      expect(adj[i]).toBeCloseTo(v, 12);
    });
  });
  it("caps at one, and is the identity for a family of one", () => {
    expect(holmAdjust([0.4, 0.6])).toEqual([0.8, 0.8]);
    expect(holmAdjust([0.03])).toEqual([0.03]);
    expect(holmAdjust([])).toEqual([]);
  });
});
