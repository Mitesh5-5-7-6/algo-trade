import type {
  BrokerConnectionState,
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
  /**
   * Live market-data feed state (plan/19 §4). Surfaced because a disconnected
   * feed is invisible from every other signal: the process is up, the engines
   * are wired, strategies are enabled — and no candle ever arrives, so nothing
   * ever fires. The operator has to be able to see that difference.
   */
  brokerConnection(): BrokerConnection;
}

/** What the control plane reports about the market-data feed. */
export interface BrokerConnection {
  state: BrokerConnectionState;
  /** True only while the feed can actually deliver ticks. */
  connected: boolean;
  /** When the state last changed; undefined if it never has. */
  since?: number | undefined;
  /**
   * Why it is not connected, in words the operator can act on — when we know.
   *
   * `disconnected` alone cannot distinguish "no token yet, go authorise" from
   * "authorised fine, but this deployment has no process that can hold a
   * socket open". Those need OPPOSITE responses, and the UI showed the same
   * "Connect FYERS…" button for both — so on a serverless deployment the
   * operator can authorise successfully, see no change, and loop forever with
   * nothing telling them the action is futile.
   *
   * Undefined when the ordinary reading applies: no token, so go and connect.
   */
  detail?: string | undefined;
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
