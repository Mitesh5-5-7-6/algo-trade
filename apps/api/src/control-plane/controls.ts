import type {
  Position,
  RiskLimits,
  SessionContext,
  StrategyConfig,
} from "@neelkanth/core";

/**
 * The slice of the engine runtime the control plane drives (plan/05 §4). A
 * config change is an in-memory update to live objects (plan/05 §2) — this is
 * that seam. Defined as an interface so the routes are unit-testable with a
 * fake, without standing up Redis.
 */
export interface RuntimeControls {
  /** Reflect a pause/kill/resume into the hot kill gate (plan/12 §4). */
  setTradingEnabled(enabled: boolean): void;
  /** Register + warm + start a strategy live (plan/15 §4). */
  enableStrategy(config: StrategyConfig): Promise<void>;
  /** Stop a strategy live. */
  disableStrategy(strategyId: string): void;
  /** Apply changed capital / limits to the running Risk Engine (plan/14 §4). */
  applyGlobalSettings(settings: {
    limits: RiskLimits;
    allocatedCapital: number;
  }): void;
  getOpenPositions(): Position[];
  realizedPnl(): number;
  unrealizedPnl(): number;
  session(): SessionContext;
}
