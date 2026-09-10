import type { Position, Signal } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import type { RiskHandoff } from "../strategy/ports.js";
import type { ExitPorts, ExitTrigger } from "./ports.js";

export interface ExitEngineDeps {
  ports: ExitPorts;
  /** The same synchronous risk→order path a strategy signal takes (plan/14 §2). */
  handoff: RiskHandoff;
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
        if (this.exiting.has(position.positionId)) continue;
        const trigger = ExitEngine.breach(position, candle);
        if (trigger === null) continue;
        await this.exit(position, trigger, candle.close, candle.ts);
      }
    } catch (error) {
      this.deps.onError(error, { where: "onCandleClosed", symbol: candle.symbol });
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
        if (this.exiting.has(position.positionId)) continue;
        await this.exit(position, "square_off", position.avgEntryPrice, now);
      }
    } catch (error) {
      this.deps.onError(error, { where: "onSessionTick" });
    }
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
    await this.deps.handoff(signal);
  }
}
