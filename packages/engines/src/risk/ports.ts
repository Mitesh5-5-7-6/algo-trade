import type {
  Position,
  RiskLimits,
  RiskLog,
  RiskRules,
  SessionPhase,
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
  readPortfolio(): Promise<PortfolioSnapshot>;
  /** The operator's global limits (plan/14 §4). */
  readGlobalLimits(): Promise<RiskLimits>;
  /** This strategy's override, if any — merged stricter-only (plan/14 §4). */
  readStrategyOverride(strategyId: string): Promise<RiskRules | null>;
  /** Append the decision to `risk_logs` — sole owner (plan/02 §8, plan/14 §7). */
  persistRiskLog(log: RiskLog): Promise<void>;
  publish: PublishFn;
}
