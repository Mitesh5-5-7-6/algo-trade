import type { Position, Signal } from "@neelkanth/core";
import type { ExitReason } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import type { ExitPorts, ExitTrigger } from "./ports.js";

/**
 * The Exit Engine's triggers, as the Trade's vocabulary (ADR §9.2).
 *
 * Only three of the seven exit reasons have a producer today. The other
 * four — STRATEGY_EXIT, TIME_EXIT, MANUAL_EMERGENCY, BROKER_RECONCILIATION
 * — are deliberately absent rather than approximated: nothing emits them,
 * and mapping a square-off onto TIME_EXIT because the names rhyme would
 * put a claim in the research dataset that no component ever made.
 */
const EXIT_REASON: Record<ExitTrigger, ExitReason> = {
  stop: "STOP_LOSS",
  target: "TAKE_PROFIT",
  square_off: "SESSION_CLOSE",
};

/**
 * What became of an exit handed to risk → order (audit A7).
 *
 * `placed: false` means no order exists — risk blocked it, or placement was
 * halted — so nothing is in flight and the exit must be tried again. A
 * handoff that reports nothing is read as placed: retrying on silence could
 * send a second closing order while the first is live.
 */
export interface ExitHandoffOutcome {
  readonly placed: boolean;
}

export interface ExitEngineDeps {
  ports: ExitPorts;
  /**
   * The same synchronous risk→order path a strategy signal takes (plan/14 §2),
   * optionally saying whether an order came of it.
   */
  handoff: (signal: Signal) => Promise<ExitHandoffOutcome | undefined>;
  nextSignalId: () => string;
  /** Confidence stamped on an exit — protective, so deliberately high. */
  exitConfidence?: number;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/** An exit is a market order; SELL closes a LONG, BUY closes a SHORT. */
function closingSide(position: Position): "BUY" | "SELL" {
  return position.side === "LONG" ? "SELL" : "BUY";
}

/**
 * The Exit Engine (plan/13, plan/14 §5): the thing that gets us *out*.
 *
 * A strategy proposes a stop and a target when it enters, and until now nothing
 * read them. The Paper Broker executes orders and does not monitor positions;
 * ORB latches `enteredUp` and never emits an exit; `marketHours.squareOff` was
 * configured, served and displayed while no engine acted on it. So a position,
 * once opened, closed only if some strategy happened to reverse. That is not a
 * risk model — it is the absence of one.
 *
 * Three triggers, all resolved against **closed bars** so the decision is
 * reproducible from stored candles:
 *
 * - **stop** — the bar's low (LONG) or high (SHORT) reached the stop.
 * - **target** — likewise for the take-profit.
 * - **square_off** — the configured intraday flatten time has passed.
 *
 * When a single bar touches both stop and target, the **stop wins**. Nothing in
 * a 5-minute OHLC bar says which came first, and assuming the favourable one
 * would make every backtest optimistic in exactly the cases that hurt most
 * (plan/11 §2 — paper must not flatter live).
 *
 * It emits an ordinary `Signal` into the same `handoff` a strategy uses, so
 * risk sees it, the Order Manager places it, and the position projection closes
 * the position — one road to the broker (plan/12 §1). Because the exit is
 * risk-*reducing*, the Risk Engine's entry/exit asymmetry (plan/14 §5) exempts
 * it from the daily-loss and exposure gates: when limits are breached the
 * machine may still get out, never in.
 */
export class ExitEngine {
  private readonly deps: ExitEngineDeps;
  private readonly exitConfidence: number;
  /** positionIds already handed off, so a re-delivered bar can't double-exit. */
  private readonly exiting = new Set<string>();

  constructor(deps: ExitEngineDeps) {
    this.deps = deps;
    this.exitConfidence = deps.exitConfidence ?? 1;
  }

  /**
   * Forget positions that are no longer open, so the guard set does not grow
   * across a session and a symbol re-entered later can exit again.
   */
  private prune(open: readonly Position[]): void {
    const live = new Set(open.map((p) => p.positionId));
    for (const id of this.exiting) if (!live.has(id)) this.exiting.delete(id);
  }

  /**
   * Evaluate stops and targets against a just-closed bar (plan/18 §6 ordering:
   * this runs on the same event the strategies decide on).
   * Never rejects — failures route to onError.
   */
  async onCandleClosed(candle: EventPayload<"CANDLE_CLOSED">): Promise<void> {
    try {
      const open = this.deps.ports.readOpenPositions();
      this.prune(open);
      for (const position of open) {
        if (position.symbol !== candle.symbol) continue;
        if (await this.alreadyExiting(position.positionId)) continue;
        const trigger = ExitEngine.breach(position, candle);
        if (trigger === null) continue;
        await this.exit(position, trigger, candle.close, candle.ts);
      }
    } catch (error) {
      this.deps.onError(error, {
        where: "onCandleClosed",
        symbol: candle.symbol,
      });
    }
  }

  /**
   * Flatten everything still open at the intraday square-off (plan/13 §6).
   * Called from the session loop with the current time; a no-op before the
   * configured minute.
   */
  async onSessionTick(now: number, squareOffTs: number): Promise<void> {
    try {
      if (now < squareOffTs) return;
      const open = this.deps.ports.readOpenPositions();
      this.prune(open);
      for (const position of open) {
        if (await this.alreadyExiting(position.positionId)) continue;
        await this.exit(position, "square_off", position.avgEntryPrice, now);
      }
    } catch (error) {
      this.deps.onError(error, { where: "onSessionTick" });
    }
  }

  /**
   * Whether an exit for this position is already on its way.
   *
   * Memory first — a warm session answers without a read. On a miss the
   * durable check runs, because the in-memory Set is empty after a restart
   * and the window it guards (handed off, not yet filled) is exactly the one
   * a restart lands in. A second exit would be a REVERSAL under Phase 2's
   * model, opening a phantom position rather than closing anything.
   */
  private async alreadyExiting(positionId: string): Promise<boolean> {
    if (this.exiting.has(positionId)) return true;
    if (await this.deps.ports.hasExitInFlight(positionId)) {
      this.exiting.add(positionId);
      return true;
    }
    return false;
  }

  /**
   * Which protective level the bar reached, if any. Stop is tested first — see
   * the class note on the both-touched case.
   */
  private static breach(
    position: Position,
    candle: EventPayload<"CANDLE_CLOSED">,
  ): ExitTrigger | null {
    const { stopLoss, target } = position;
    if (position.side === "LONG") {
      if (stopLoss !== undefined && candle.low <= stopLoss) return "stop";
      if (target !== undefined && candle.high >= target) return "target";
      return null;
    }
    if (stopLoss !== undefined && candle.high >= stopLoss) return "stop";
    if (target !== undefined && candle.low <= target) return "target";
    return null;
  }

  /** Record the exit decision and hand it to risk → order (plan/14 §2). */
  private async exit(
    position: Position,
    trigger: ExitTrigger,
    price: number,
    ts: number,
  ): Promise<void> {
    this.exiting.add(position.positionId);
    const signal: Signal = {
      signalId: this.deps.nextSignalId(),
      strategyId: position.strategyId,
      symbol: position.symbol,
      side: closingSide(position),
      confidence: this.exitConfidence,
      qtyProposal: position.qty,
      reason: `exit: ${trigger}`,
      exitReason: EXIT_REASON[trigger],
      // Carried so the order can be found again by position — the durable
      // guard has nothing to match on otherwise (D3).
      positionId: position.positionId,
      contextSnapshot: {
        price,
        indicators: {},
        session: "open",
        sentiment: 0,
      },
      ts,
    };
    // Persisted before it is acted on, like every other decision (plan/07):
    // an exit that fails downstream must still be visible as having been made.
    await this.deps.ports.persistSignal(signal);
    const outcome = await this.deps.handoff(signal);
    // No order came of it (risk blocked it), so nothing is in flight: clear
    // the mark, or every later bar skips the position and it stays open with
    // no exit coming until a restart — the orphan §7 forbids (audit A7).
    if (outcome?.placed === false) this.exiting.delete(position.positionId);
  }
}
