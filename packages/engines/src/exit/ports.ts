import type { Position, SessionContext, Signal } from "@neelkanth/core";

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
}

/** Why the Exit Engine decided to flatten — recorded on the signal's reason. */
export type ExitTrigger = "stop" | "target" | "square_off";
