import type {
  CheckpointOddsTable,
  ExitRules,
  PivotLevels,
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
  /**
   * Move a position's stop, so a trail survives the process that set it (D4).
   *
   * Held in the position rather than in the engine: a restart that forgot
   * where the trail had reached would hand the position back its ENTRY stop,
   * silently widening the risk on a trade that had already been protected.
   */
  updateStopLoss(positionId: string, stopLoss: number): Promise<void>;
  /**
   * The three-part target's odds table (PLAN.md 14.17), or null while none
   * has been fetched. Optional: without it the checkpoints are off and the
   * engine judges stop and target alone — replay and the golden record run
   * so, unchanged.
   */
  readCheckpointOdds?(): CheckpointOddsTable | null;
  /** The last price of a symbol — the index, for an option's checkpoint. */
  readPrice?(symbol: string): number | null;
  /** Today's floor pivots for an index, from its previous session (14.19). */
  readPivots?(underlying: string): PivotLevels | null;
  /** Move a live position's target, durably — a rebound trade's T1 (14.19). */
  updateTarget?(positionId: string, target: number): Promise<void>;
}

/**
 * Why the Exit Engine decided to flatten — recorded on the signal's reason.
 * `time` and `manual` are Phase 3 (D2, D5).
 */
export type ExitTrigger =
  | "stop"
  | "target"
  | "time"
  | "square_off"
  | "manual"
  /** A three-part target's checkpoint, whose next part was unlikely (14.17). */
  | "checkpoint"
  /** SL1 or SL2 crossed and a bounce was unlikely: a smaller loss now (14.19). */
  | "early_stop";
