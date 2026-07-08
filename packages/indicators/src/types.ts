import type { Candle } from "@neelkanth/core";

/** Indicators fold over candles (plan/18 §3). */
export type Bar = Candle;

/**
 * A pure, incremental indicator (plan/18 §3, §7). One implementation of the
 * math, consumed identically by the live Indicator Engine and by tests /
 * backtests — so a passing test is a statement about production math, not a
 * copy of it (plan/18 §7).
 *
 * `fold` is an O(1) per-bar update that mutates and returns the state (the
 * incremental discipline of plan/18 §3 — no recompute over history). `read`
 * returns named output values, or `null` until the indicator is `ready`;
 * serving an unconverged value is the least-detectable kind of wrong
 * (plan/18 §4), so callers gate on `ready`.
 */
export interface Indicator<S> {
  /** Registration key for dedup across strategies, e.g. "ema9" (plan/18 §2). */
  readonly key: string;
  /** VWAP-class indicators reset at the bell (plan/18 §5); rolling ones don't. */
  readonly sessionAnchored: boolean;
  /** Bars of history needed before `ready` — drives warm-up loading (plan/18 §4). */
  readonly warmupBars: number;
  init(): S;
  fold(state: S, bar: Bar): S;
  read(state: S): Readonly<Record<string, number>> | null;
  ready(state: S): boolean;
}
