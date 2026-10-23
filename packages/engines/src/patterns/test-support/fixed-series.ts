import type { Candle } from "@neelkanth/core";

/**
 * The detector pin's series (Phase 5 D5): `sessions` weekdays of 5m bars, REAL
 * volume, every detector firing at least once on the first three. A session
 * beyond the third continues the same waves, so it differs from every one
 * before it — which the lookahead test needs (D7).
 *
 * Integer arithmetic only — two triangle waves and an LCG, in paise — so the
 * series is bit-identical on every runtime. `Math.sin` is not required to
 * be, and a pin that drifted with the platform would teach people to ignore
 * it.
 */
export function fixedSeries(sessions = 3): Candle[] {
  // Consecutive weekdays from Monday 2026-01-05, 09:15 IST.
  const opens = Array.from({ length: sessions }, (_, d) => {
    const day = d + 2 * Math.floor(d / 5); // skip weekends
    return Date.UTC(2026, 0, 5 + day, 3, 45);
  });
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
