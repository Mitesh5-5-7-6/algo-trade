import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import {
  DEFAULT_REGIME_MODEL,
  REGIME_MODEL_VERSION,
  regimeAt,
  regimeFingerprint,
  regimeTimeline,
} from "./regime.js";

/**
 * Task 6.3 (design D4): the regime label — the index's close against its
 * EMA(21), from bars at or before each label's own, versioned, volume-free.
 */
const INDEX = DEFAULT_REGIME_MODEL.symbol;
const OPEN = [Date.UTC(2026, 0, 5, 3, 45), Date.UTC(2026, 0, 6, 3, 45)];
const BAR_MS = 300_000;

/** Integer arithmetic only — two triangle waves, in paise — like the detector pin. */
function series(days = 2, fields: Partial<Candle> = {}): Candle[] {
  const triangle = (i: number, period: number, amplitude: number): number => {
    const phase = i % period;
    const half = period / 2;
    return Math.round(
      ((phase < half ? phase : period - phase) / half) * 2 * amplitude -
        amplitude,
    );
  };
  const out: Candle[] = [];
  let i = 0;
  for (let d = 0; d < days; d += 1) {
    const open = Date.UTC(2026, 0, 5 + d, 3, 45);
    for (let k = 0; k < 75; k += 1, i += 1) {
      const close =
        (25_000_00 + triangle(i, 60, 9_000) + triangle(i, 16, 2_500)) / 100;
      out.push({
        symbol: INDEX,
        interval: "5m",
        source: "BROKER_HISTORICAL",
        open: close,
        high: close + 5,
        low: close - 5,
        close,
        volume: 1_000 + ((i * 37) % 700),
        volumeAvailable: true,
        volumeQuality: "SUSPECT",
        ts: open + k * BAR_MS,
        ...fields,
      });
    }
  }
  return out;
}

describe("the regime label (6.3, D4)", () => {
  it("is NEUTRAL until its EMA is warm, then reads the index against it", () => {
    const rising = Array.from({ length: 30 }, (_, k): Candle => ({
      ...(series(1)[0] as Candle),
      close: 100 + k,
      ts: (OPEN[0] ?? 0) + k * BAR_MS,
    }));
    const t = regimeTimeline(rising);
    expect(t.regime.slice(0, 20).every((r) => r === "NEUTRAL")).toBe(true);
    expect(t.regime.slice(21)).toEqual(Array(9).fill("BULLISH"));
    const falling = rising.map((c, k) => ({ ...c, close: 200 - k }));
    expect(regimeTimeline(falling).regime.at(-1)).toBe("BEARISH");
    const flat = rising.map((c) => ({ ...c, close: 100 }));
    expect(regimeTimeline(flat).regime.at(-1)).toBe("NEUTRAL");
  });

  /** F1: the label draws no conclusion from volume, trusted or not. */
  it("is volume-free", () => {
    const a = regimeTimeline(series());
    const b = regimeTimeline(
      series(2, {
        volume: 0,
        volumeAvailable: false,
        volumeQuality: "UNAVAILABLE",
      }),
    );
    expect(b.regime).toEqual(a.regime);
  });

  it("carries the trend across the overnight gap, as the live trend does", () => {
    const both = regimeTimeline(series(2));
    const dayTwoAlone = regimeTimeline(series(2).slice(75));
    // Alone, day two's first 20 bars cannot be read; after day one, they can.
    expect(dayTwoAlone.regime.slice(0, 20).every((r) => r === "NEUTRAL")).toBe(
      true,
    );
    expect(both.regime.slice(75, 95).some((r) => r !== "NEUTRAL")).toBe(true);
  });

  /** Spec §5.4, the strong form: every prefix agrees with the whole. */
  it("labels each bar from bars at or before it only", () => {
    const candles = series(3);
    const full = regimeTimeline(candles);
    const disagreements: number[] = [];
    for (let n = 1; n <= candles.length; n += 1) {
      const prefix = regimeTimeline(candles.slice(0, n));
      if (
        JSON.stringify(prefix.regime) !==
        JSON.stringify(full.regime.slice(0, n))
      )
        disagreements.push(n);
    }
    expect(disagreements).toEqual([]);
    // A fair test: the series moves through every label.
    expect(new Set(full.regime)).toEqual(
      new Set(["NEUTRAL", "BULLISH", "BEARISH"]),
    );
  });

  it("gives any symbol's bar the latest index label at or before it, never a later one", () => {
    const t = regimeTimeline(series(1));
    const at = (k: number) => (OPEN[0] ?? 0) + k * BAR_MS;
    expect(regimeAt(t, at(40))).toBe(t.regime[40]);
    expect(regimeAt(t, at(40) + 60_000)).toBe(t.regime[40]); // between bars
    expect(regimeAt(t, at(0) - 1)).toBe("NEUTRAL"); // before any
    expect(regimeAt(t, at(500))).toBe(t.regime.at(-1)); // after the last
  });

  it("refuses bars out of order, or from another symbol", () => {
    const candles = series(1);
    expect(() =>
      regimeTimeline([candles[1] as Candle, candles[0] as Candle]),
    ).toThrow(/ascending/);
    expect(() =>
      regimeTimeline([
        { ...(candles[0] as Candle), symbol: "NSE:OTHER-INDEX" },
      ]),
    ).toThrow(/NSE:OTHER-INDEX/);
  });

  /**
   * D4's version pin, as Phase 5's D5: change what a label means without
   * bumping REGIME_MODEL_VERSION and this fails.
   */
  it("is pinned to its version", () => {
    const t = regimeTimeline(series(3));
    const counts = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
    for (const r of t.regime) counts[r] += 1;
    expect({
      version: REGIME_MODEL_VERSION,
      counts,
      outputs: regimeFingerprint(t),
    }).toEqual(PIN);
  });
});

const PIN = {
  version: "1",
  counts: { BULLISH: 110, BEARISH: 95, NEUTRAL: 20 },
  outputs: "a65688cdc1e4b34221dd1140c2f9d2076ae9453e83be1fa974ed853818b4f5c2",
};
