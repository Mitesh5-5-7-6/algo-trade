import type { Position } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import {
  applyFill,
  isSameSide,
  type Fill,
  type PositionState,
} from "./position-math.js";
import type { PositionPorts } from "./ports.js";

export interface PositionEngineDeps {
  ports: PositionPorts;
  nextPositionId: () => string;
  now?: () => number;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The Position Engine (plan/13 §3): derives what we hold — per symbol, per
 * strategy — from confirmed fills. It makes no decisions; it is a pure
 * projection of facts that already happened (plan/02 §6, Regime B), so it lives
 * on the event bus, not the critical path.
 *
 * Sole writer of position state (plan/02 §8). Idempotent by `orderId`: a
 * re-delivered ORDER_FILLED (e.g. a resync after reconnect) is ignored, so
 * recovery can never double-count a fill and corrupt position or PnL
 * (plan/13 §3). Maintains running realized-PnL counters (global and per
 * strategy) that the Risk Engine's daily-loss check and the PnL Engine read.
 */
export class PositionEngine {
  private readonly ports: PositionPorts;
  private readonly nextPositionId: () => string;
  private readonly now: () => number;
  private readonly onError: PositionEngineDeps["onError"];
  /** `${strategyId}|${symbol}` → the current position (may be CLOSED). */
  private readonly positions = new Map<string, Position>();
  /** Applied fill orderIds — the idempotency guard (plan/13 §3). */
  private readonly applied = new Set<string>();
  private globalRealizedPnl = 0;
  private readonly realizedByStrategy = new Map<string, number>();
  private tradeCount = 0;

  constructor(deps: PositionEngineDeps) {
    this.ports = deps.ports;
    this.nextPositionId = deps.nextPositionId;
    this.now = deps.now ?? (() => Date.now());
    this.onError = deps.onError;
  }

  private static key(strategyId: string, symbol: string): string {
    return `${strategyId}|${symbol}`;
  }

  /** Rebuild in-memory state from durable open positions on boot (plan/13 §8). */
  hydrate(open: readonly Position[]): void {
    for (const position of open) {
      if (position.status === "OPEN") {
        this.positions.set(
          PositionEngine.key(position.strategyId, position.symbol),
          position,
        );
      }
    }
  }

  getOpenPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === "OPEN");
  }

  getPosition(strategyId: string, symbol: string): Position | null {
    const position = this.positions.get(PositionEngine.key(strategyId, symbol));
    return position && position.status === "OPEN" ? position : null;
  }

  /** Global realized PnL since the last reset (plan/13 §5); loss = negative. */
  realizedPnl(): number {
    return this.globalRealizedPnl;
  }

  realizedPnlForStrategy(strategyId: string): number {
    return this.realizedByStrategy.get(strategyId) ?? 0;
  }

  getTradeCount(): number {
    return this.tradeCount;
  }

  /** Zero the daily realized counters at session start (plan/13 §5, plan/14 §6). */
  resetDaily(): void {
    this.globalRealizedPnl = 0;
    this.realizedByStrategy.clear();
    this.tradeCount = 0;
  }

  /** Apply a confirmed fill (plan/13 §3). Idempotent; never rejects. */
  async onOrderFilled(payload: EventPayload<"ORDER_FILLED">): Promise<void> {
    try {
      if (this.applied.has(payload.orderId)) return; // idempotency (plan/13 §3)
      this.applied.add(payload.orderId);
      this.tradeCount += 1;

      const key = PositionEngine.key(payload.strategyId, payload.symbol);
      const existing = this.positions.get(key) ?? null;
      const currentOpen = existing?.status === "OPEN" ? existing : null;
      const fill: Fill = {
        side: payload.side,
        qty: payload.qty,
        price: payload.filledPrice,
        charges: payload.charges,
      };
      const currentState = currentOpen ? toState(currentOpen) : null;

      // Apply the (possibly closing) fill.
      const nextState = applyFill(currentState, fill);
      const prevRealized = currentOpen?.realizedPnl ?? 0;
      this.recordRealized(
        payload.strategyId,
        nextState.realizedPnl - prevRealized,
      );
      const nextPosition = this.materialize(currentOpen, nextState, payload);
      this.positions.set(key, nextPosition);
      await this.ports.writePosition(nextPosition);
      await this.emit(nextPosition);

      // A reversal (an opposite fill larger than the position): the close above
      // realized PnL and left it CLOSED; now open the remainder as a NEW
      // position — charges already applied, so 0 here (plan/13 §3).
      if (
        currentOpen !== null &&
        currentState !== null &&
        !isSameSide(currentState, fill) &&
        fill.qty > currentOpen.qty
      ) {
        const excess = fill.qty - currentOpen.qty;
        const openedState = applyFill(null, {
          side: fill.side,
          qty: excess,
          price: fill.price,
          charges: 0,
        });
        const opened = this.materialize(null, openedState, payload);
        this.positions.set(key, opened);
        await this.ports.writePosition(opened);
        await this.emit(opened);
      }
    } catch (error) {
      this.onError(error, {
        where: "onOrderFilled",
        orderId: payload.orderId,
      });
    }
  }

  private recordRealized(strategyId: string, delta: number): void {
    this.globalRealizedPnl += delta;
    this.realizedByStrategy.set(
      strategyId,
      (this.realizedByStrategy.get(strategyId) ?? 0) + delta,
    );
  }

  private materialize(
    current: Position | null,
    state: PositionState,
    payload: EventPayload<"ORDER_FILLED">,
  ): Position {
    const now = this.now();
    if (current === null) {
      return {
        positionId: this.nextPositionId(),
        symbol: payload.symbol,
        strategyId: payload.strategyId,
        side: state.side,
        qty: state.qty,
        avgEntryPrice: state.avgEntryPrice,
        status: state.status,
        realizedPnl: state.realizedPnl,
        unrealizedPnl: 0,
        openedAt: now,
        ...(state.status === "CLOSED" ? { closedAt: now } : {}),
        mode: payload.mode,
      };
    }
    return {
      ...current,
      side: state.side,
      qty: state.qty,
      avgEntryPrice: state.avgEntryPrice,
      status: state.status,
      realizedPnl: state.realizedPnl,
      ...(state.status === "CLOSED" && current.closedAt === undefined
        ? { closedAt: now }
        : {}),
    };
  }

  private async emit(position: Position): Promise<void> {
    await this.ports.publish(
      "POSITION_UPDATED",
      {
        symbol: position.symbol,
        strategyId: position.strategyId,
        side: position.side,
        qty: position.qty,
        avgEntryPrice: position.avgEntryPrice,
        status: position.status,
        realizedPnl: position.realizedPnl,
        ts: this.now(),
      },
      position.positionId,
    );
  }
}

function toState(position: Position): PositionState {
  return {
    side: position.side,
    qty: position.qty,
    avgEntryPrice: position.avgEntryPrice,
    realizedPnl: position.realizedPnl,
    status: position.status,
  };
}
