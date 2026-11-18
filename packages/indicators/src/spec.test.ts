import { describe, expect, it } from "vitest";
import {
  atr,
  avgVolume,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  supertrend,
  vwap,
} from "./index.js";
import { indicatorKey, type IndicatorSpec } from "./spec.js";

describe("indicatorKey (plan/18 §2)", () => {
  it("matches each fold's own key, so declaration and computation never drift", () => {
    const cases: [IndicatorSpec, string][] = [
      [{ kind: "ema", period: 9 }, ema(9).key],
      [{ kind: "rsi", period: 14 }, rsi(14).key],
      [{ kind: "atr", period: 10 }, atr(10).key],
      [{ kind: "vwap" }, vwap().key],
      [{ kind: "sma", period: 20 }, sma(20).key],
      [{ kind: "avgVolume", period: 20 }, avgVolume(20).key],
      [
        { kind: "supertrend", period: 10, multiplier: 3 },
        supertrend(10, 3).key,
      ],
      [{ kind: "macd", fast: 12, slow: 26, signal: 9 }, macd(12, 26, 9).key],
      [{ kind: "bollinger", period: 20, stdDev: 2 }, bollinger(20, 2).key],
    ];
    for (const [spec, key] of cases) {
      expect(indicatorKey(spec)).toBe(key);
    }
  });
});
