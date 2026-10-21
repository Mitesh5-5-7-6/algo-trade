import type {
  ExitRules,
  Position,
  SessionContext,
  Signal,
} from "@neelkanth/core";

/**
 * Infrastructure the Exit Engine reads/writes through, injected so it stays
 * infra-free and unit-testable (plan/05 §3). Deliberately narrow: the engine
 * reads what is open, records the decision, and hands the exit to the same
 * risk→order path a strategy's signal takes. It has no broker of its own.
 */
export interface ExitPorts {
  /** Every currently OPEN position, across strategies (plan/13 §7). */
  readOpenPositions(): readonly Position[];
  /** Current session phase + anchors (plan/15 §3, from hot:session). */
  readSession(): Promise<SessionContext>;
  /** Persist the exit decision to `signals` — the same audit trail (plan/07). */
  persistSignal(signal: Signal): Promise<void>;
  /**
   * Whether an exit order for this position is already live (D3).
   *
   * Consulted only when the in-memory guard does not already know, so a
   * warm session pays nothing. After a restart it is the only thing that
   * knows an exit was already sent.
   */
  hasExitInFlight(positionId: string): Promise<boolean>;
  /**
   * This strategy's exit rules, or null if it has none configured.
   *
   * Synchronous and in memory: asked on every closed bar for every open
   * position. The rules are those the running instance was enabled with; an
   * edit takes effect when it re-provisions the strategy, as a params edit
   * does.
   */
  readExitRules(strategyId: string): ExitRules | null;
}

/**
 * Why the Exit Engine decided to flatten — recorded on the signal's reason.
 * `time` is Phase 3 D2.
 */
export type ExitTrigger = "stop" | "target" | "time" | "square_off";
