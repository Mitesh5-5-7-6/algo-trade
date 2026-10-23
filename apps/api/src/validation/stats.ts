/**
 * Statistics primitives for the gate (Phase 7 D1).
 *
 * Pure and deterministic. Each is pinned in stats.test.ts against values
 * computed elsewhere (R, SciPy, statsmodels, or by hand), because a
 * statistics bug produces plausible numbers and nothing else.
 */

/**
 * Standard normal CDF, Φ(z). W. J. Cody's rational Chebyshev erfc (via the
 * Numerical Recipes form), relative error below 1.2e-7 everywhere.
 */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/**
 * Standard normal quantile, Φ⁻¹(p). Acklam's algorithm, relative error below
 * 1.2e-9 on (0, 1).
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1))
    throw new Error(`normalQuantile needs 0 < p < 1, got ${String(p)}`);
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  const poly = (k: number[], x: number): number =>
    k.reduce((acc, ki) => acc * x + ki, 0);
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(c, q) / (poly(d, q) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -poly(c, q) / (poly(d, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (poly(a, r) * q) / (poly(b, r) * r + 1);
}

export interface Interval {
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for `successes` of `n` at critical value `z`. Unlike
 * the textbook p ± z·√(p(1−p)/n), it never leaves [0, 1] and does not
 * collapse to a point at 0 or n successes — exactly where small samples live.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z: number,
): Interval {
  if (n <= 0) throw new Error("wilsonInterval needs n > 0");
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half =
    (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, centre - half),
    upper: Math.min(1, centre + half),
  };
}

/**
 * Exact one-sided binomial tail P(X ≥ k) for X ~ Bin(n, p).
 *
 * ln C(n, j) is built by the recurrence ln C(n, j+1) = ln C(n, j) +
 * ln((n − j)/(j + 1)) — elementary arithmetic, accurate to rounding — and the
 * terms are summed in log space from the largest, so it holds for n in the
 * thousands. (A Lanczos log-gamma was tried first and drifted by 1e-8.)
 */
export function binomialUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lnChoose = 0;
  for (let i = 1; i <= k; i += 1) lnChoose += Math.log((n - k + i) / i);
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  const logs: number[] = [];
  for (let j = k; j <= n; j += 1) {
    logs.push(lnChoose + j * lp + (n - j) * lq);
    lnChoose += Math.log((n - j) / (j + 1));
  }
  const max = Math.max(...logs);
  const sum = logs.reduce((acc, l) => acc + Math.exp(l - max), 0);
  return Math.min(1, Math.exp(max + Math.log(sum)));
}

/**
 * Exact one-sided binomial tail P(X ≤ k), computed as the upper tail of the
 * complement — P(Y ≥ n − k) for Y ~ Bin(n, 1 − p) — never as 1 − P(X ≥ k+1),
 * which cancels to zero below ~1e-16.
 */
export function binomialLowerTail(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  return binomialUpperTail(n - k, n, 1 - p);
}

/** Sample standard deviation (n − 1); 0 for fewer than two values. */
export function sampleStdDev(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const ss = values.reduce((a, v) => a + (v - mean) * (v - mean), 0);
  return Math.sqrt(ss / (n - 1));
}

/** mean ± z·sd/√n. */
export function meanInterval(
  mean: number,
  sd: number,
  n: number,
  z: number,
): Interval {
  if (n <= 0) throw new Error("meanInterval needs n > 0");
  const half = (z * sd) / Math.sqrt(n);
  return { lower: mean - half, upper: mean + half };
}

/**
 * One-sided z-test p-value for a mean against `mu0`: H1 is mean > mu0
 * (`greater`) or mean < mu0 (`less`). A zero spread decides by the sign alone.
 */
export function meanPValue(
  mean: number,
  sd: number,
  n: number,
  mu0: number,
  direction: "greater" | "less",
): number {
  if (n <= 0) throw new Error("meanPValue needs n > 0");
  if (sd === 0) {
    const holds = direction === "greater" ? mean > mu0 : mean < mu0;
    return holds ? 0 : 1;
  }
  const z = (mean - mu0) / (sd / Math.sqrt(n));
  return direction === "greater" ? 1 - normalCdf(z) : normalCdf(z);
}

/**
 * Holm's step-down correction. Returns, in the input order, each p-value
 * adjusted for the whole family (`min(1, (m − i + 1)·p₍ᵢ₎)`, made monotone).
 * Reject where the adjusted value is below alpha. Uniformly more powerful than
 * Bonferroni, and valid under any dependence between the tests.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p || a.i - b.i);
  const adjusted: number[] = new Array<number>(m).fill(1);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}
