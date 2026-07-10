import type {
  Candle,
  CandleInterval,
  Position,
  SessionContext,
  Signal,
} from "@neelkanth/core";
import type { IndicatorSpec } from "@neelkanth/indicators";
import type { PublishFn } from "../market-data/ports.js";

/**
 * Infrastructure the Strategy Engine reads/writes through, injected so the
 * runner stays infra-free and unit-testable (plan/05 §3). The composition root
 * implements these with redis (hot session), db (candle window, position read,
 * signals write), and the bus; tests pass in-memory fakes.
 */
export interface StrategyPorts {
  /** Current session phase + minutes-since-open (plan/15 §3, from hot:session). */
  readSession(): Promise<SessionContext>;
  /** The recent candle window (oldest→newest, incl. the just-closed bar). */
  readCandleWindow(
    symbol: string,
    interval: CandleInterval,
    count: number,
  ): Promise<Candle[]>;
  /** This strategy's open position for the symbol, read-only (plan/13 §7). */
  readPosition(strategyId: string, symbol: string): Promise<Position | null>;
  /** Cached AI sentiment; 0 when absent (Phase 1, plan/20). */
  readSentiment(symbol: string): Promise<number>;
  /** Persist the decision to `signals` — sole owner (plan/02 §8, plan/07). */
  persistSignal(signal: Signal): Promise<void>;
  publish: PublishFn;
}

/**
 * Called when a strategy is enabled so the engine arranges for its indicators
 * to exist and be warmed (plan/15 §2, plan/18 §4). The composition root wires
 * this to IndicatorEngine.registerSpec + warmUp.
 */
export type IndicatorProvisioner = (
  symbol: string,
  interval: CandleInterval,
  specs: readonly IndicatorSpec[],
) => Promise<void>;

/**
 * The synchronous risk→order handoff (plan/02 §6 Regime A, plan/14 §2). The
 * runner calls this with an approved-for-forwarding signal; the composition
 * root wires it to `RiskEngine.validate()` → `OrderManager.place()` as a
 * direct in-process call — never a queue, or the duplicate-order race reopens.
 */
export type RiskHandoff = (signal: Signal) => Promise<void>;
