import type {
  Instrument,
  MarketView,
  Position,
  RiskLimits,
  RiskLog,
  RiskRules,
  SessionPhase,
  Signal,
} from "@neelkanth/core";
import type { PublishFn } from "../market-data/ports.js";

/** Portfolio aggregates the size/exposure check reads (plan/13 §4, plan/14 §4). */
export interface PortfolioSnapshot {
  allocatedCapital: number;
  investedValue: number;
  availableCapital: number;
}

/**
 * Infrastructure the Risk Engine reads/writes through, injected so the engine
 * stays infra-free and unit-testable (plan/05 §3). The composition root
 * implements these with redis (`risk:` counters, `hot:session`), the Portfolio
 * Engine (aggregates), and db (`risk_logs`); tests pass fakes.
 *
 * Every read can fail — and on failure the engine blocks (fail-closed,
 * plan/14 §9): an unverifiable signal is an unapproved signal.
 */
export interface RiskPorts {
  readSession(): Promise<SessionPhase>;
  /** Today's realized loss as a positive magnitude (plan/14 §4.3). */
  readDailyRealizedLoss(): Promise<number>;
  /** Count of currently open positions (plan/14 §4). */
  readOpenPositionCount(): Promise<number>;
  /** This strategy's open position for the symbol, to classify entry vs exit. */
  readPosition(strategyId: string, symbol: string): Promise<Position | null>;
  /** Is an equivalent intent already in flight or open? (plan/14 §4.2). */
  hasInflightIntent(
    strategyId: string,
    symbol: string,
    side: "BUY" | "SELL",
  ): Promise<boolean>;
  /**
   * The capital a signal is sized against: its strategy's own, when the
   * strategy has an allocation (2026-11-18), otherwise the account's.
   */
  readPortfolio(strategyId?: string): Promise<PortfolioSnapshot>;
  /**
   * True once the intraday square-off time has passed (found 2026-11-18: an
   * EMA crossover entry at 15:30, after the 15:12 square-off, was carried
   * overnight). New entries are refused from then on; exits never are.
   * Absent, nothing is refused on this ground.
   */
  entriesClosed?(): boolean;
  /**
   * The cached market view (plan/14 §4). Synchronous-by-cache: the gate reads
   * a value the Market Bias Engine already computed on candle close, never
   * computing one on the critical path.
   */
  readMarketView(): MarketView;
  /**
   * The operator's applied lessons on this entry (PLAN.md 14.28): synchronous,
   * read from what the runtime already computed for the signal. Null when no
   * applied lesson is in scope. Absent, there are no lessons.
   */
  readLessonVerdict?(
    signal: Signal,
  ): { blocked: boolean; detail: string } | null;
  /**
   * The contract this symbol names, for its lot size. Null when the symbol
   * master has no such row — which the sizing step must treat as a reason to
   * refuse a derivative, not as "lot size 1".
   */
  readInstrument(symbol: string): Instrument | null;
  /** The operator's global limits (plan/14 §4). */
  readGlobalLimits(): Promise<RiskLimits>;
  /** This strategy's override, if any — merged stricter-only (plan/14 §4). */
  readStrategyOverride(strategyId: string): Promise<RiskRules | null>;
  /** Append the decision to `risk_logs` — sole owner (plan/02 §8, plan/14 §7). */
  persistRiskLog(log: RiskLog): Promise<void>;
  publish: PublishFn;
}
