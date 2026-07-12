import type { CandleInterval } from "@neelkanth/core";
import {
  atr,
  avgVolume,
  ema,
  rsi,
  sma,
  vwap,
  type IndicatorSpec,
} from "@neelkanth/indicators";
import type { IndicatorEngine } from "./indicator-engine.js";

/**
 * Register a declarative IndicatorSpec (plan/15 §2) on the Indicator Engine by
 * mapping it to the matching fold factory. The switch keeps each `register`
 * call monomorphic (no `any`), and centralizes the spec→fold mapping in one
 * place — used by the Strategy Engine's provisioning and the composition root.
 */
export function registerIndicatorSpec(
  engine: IndicatorEngine,
  symbol: string,
  interval: CandleInterval,
  spec: IndicatorSpec,
): void {
  switch (spec.kind) {
    case "ema":
      engine.register(symbol, interval, ema(spec.period));
      return;
    case "rsi":
      engine.register(symbol, interval, rsi(spec.period));
      return;
    case "atr":
      engine.register(symbol, interval, atr(spec.period));
      return;
    case "vwap":
      engine.register(symbol, interval, vwap());
      return;
    case "sma":
      engine.register(symbol, interval, sma(spec.period));
      return;
    case "avgVolume":
      engine.register(symbol, interval, avgVolume(spec.period));
      return;
  }
}
