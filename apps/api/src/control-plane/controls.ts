import type {
  Position,
  RiskLimits,
  SessionContext,
  StrategyConfig,
} from "@neelkanth/core";
import type { EquityPoint } from "@neelkanth/engines";

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
  /** Today's intraday equity samples, oldest first (plan/06 §4 day curve). */
  equityCurve(): readonly EquityPoint[];
}

/**
 * Step-up re-auth gate for dangerous control actions (plan/21 §5): resuming
 * after a kill, changing capital, loosening risk limits. Resolves if the
 * operator re-confirmed, throws (StepUpRequiredError / UnauthorizedError)
 * otherwise. Injected — so control-plane routes never import the auth layer,
 * and the enforcement is a fake in route tests. `userId` is the acting
 * operator (from the resolved session); `undefined` when unauthenticated.
 */
export type StepUpVerifier = (
  userId: string | undefined,
  password: string | undefined,
) => Promise<void>;
