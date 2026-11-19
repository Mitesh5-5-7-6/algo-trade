/**
 * A declarative indicator request (plan/15 §2): strategies *declare* what they
 * need as plain data; the Indicator Engine maps each spec to the matching fold
 * and registers it. This decouples strategies from the fold factories — a
 * strategy never computes its own EMA (plan/18 §2).
 */
export type IndicatorSpec =
  | { readonly kind: "ema"; readonly period: number }
  | { readonly kind: "rsi"; readonly period: number }
  | { readonly kind: "atr"; readonly period: number }
  | { readonly kind: "vwap" }
  | { readonly kind: "sma"; readonly period: number }
  | { readonly kind: "avgVolume"; readonly period: number }
  | {
      readonly kind: "supertrend";
      readonly period: number;
      readonly multiplier: number;
    }
  | {
      readonly kind: "macd";
      readonly fast: number;
      readonly slow: number;
      readonly signal: number;
    }
  | {
      readonly kind: "bollinger";
      readonly period: number;
      readonly stdDev: number;
    };

/**
 * The hot-state / context key a spec's value appears under (e.g. "ema9").
 * Mirrors each fold's own `key`; a test asserts they never drift.
 */
export function indicatorKey(spec: IndicatorSpec): string {
  switch (spec.kind) {
    case "ema":
      return `ema${String(spec.period)}`;
    case "rsi":
      return `rsi${String(spec.period)}`;
    case "atr":
      return `atr${String(spec.period)}`;
    case "vwap":
      return "vwap";
    case "sma":
      return `sma${String(spec.period)}`;
    case "avgVolume":
      return `avgvol${String(spec.period)}`;
    case "supertrend":
      return `supertrend${String(spec.period)}x${String(spec.multiplier)}`;
    case "macd":
      return `macd${String(spec.fast)}_${String(spec.slow)}_${String(spec.signal)}`;
    case "bollinger":
      return `bb${String(spec.period)}x${String(spec.stdDev)}`;
  }
}
