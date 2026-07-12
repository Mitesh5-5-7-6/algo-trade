import type { PnlSnapshot, Position } from "@neelkanth/core";
import { unrealizedPnl } from "./position-math.js";
import type { PnlPorts } from "./ports.js";

export interface RealizedSnapshot {
  global: number;
  byStrategy: ReadonlyMap<string, number>;
}

export interface PnlEngineDeps {
  ports: PnlPorts;
  /** Current open positions (from the Position Engine, in-process). */
  getOpenPositions: () => readonly Position[];
  /** Running realized PnL (from the Position Engine). */
  getRealized: () => RealizedSnapshot;
  getTradeCount: () => number;
  now?: () => number;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

/**
 * The PnL Engine (plan/13 §5): computes realized and unrealized profit/loss and
 * emits PNL_UPDATED. It keeps the two distinct — **realized** is locked in by
 * closing fills (changes only on POSITION_UPDATED) and is what feeds the Risk
 * Engine's daily-loss counter; **unrealized** is mark-to-market of open
 * positions (changes with every tick), recomputed from live price. Conflating
 * them would make the risk gate either too twitchy or dishonest (plan/13 §5).
 *
 * Reads position state directly from the Position Engine (same process,
 * Regime B chain); emission throttling for the tick-driven path happens at the
 * socket bridge (plan/10 §6), not here.
 */
export class PnlEngine {
  private readonly deps: PnlEngineDeps;
  private readonly now: () => number;

  constructor(deps: PnlEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Sum mark-to-market unrealized PnL across open positions (plan/13 §5). */
  private async computeUnrealized(): Promise<number> {
    let total = 0;
    for (const position of this.deps.getOpenPositions()) {
      const price = await this.deps.ports.readPrice(position.symbol);
      if (price !== null) total += unrealizedPnl(position, price);
      // No price ⇒ hold last mark (contribute nothing); staleness is visible
      // elsewhere (plan/13 §8). Never fabricate a mark.
    }
    return total;
  }

  /**
   * Recompute global PnL and emit PNL_UPDATED. Triggered on POSITION_UPDATED
   * (realized changed) and on a throttled MARKET_TICK (unrealized changed).
   */
  async refresh(): Promise<void> {
    try {
      const unrealized = await this.computeUnrealized();
      const realized = this.deps.getRealized().global;
      await this.deps.ports.publish("PNL_UPDATED", {
        scope: "global",
        realizedPnl: realized,
        unrealizedPnl: unrealized,
        ts: this.now(),
      });
    } catch (error) {
      this.deps.onError(error, { where: "refresh" });
    }
  }

  /**
   * The EOD closing pass (plan/13 §6): persist the day's realized/unrealized
   * snapshot per scope to `pnl_snapshots` — the durable equity curve.
   */
  async snapshot(date: string): Promise<void> {
    try {
      const positions = this.deps.getOpenPositions();
      const realized = this.deps.getRealized();
      const ts = this.now();

      let globalUnrealized = 0;
      for (const position of positions) {
        const price = await this.deps.ports.readPrice(position.symbol);
        if (price !== null) globalUnrealized += unrealizedPnl(position, price);
      }

      const write = (
        scope: string,
        realizedPnl: number,
        unrealized: number,
        tradeCount: number,
      ): Promise<void> =>
        this.deps.ports.writeSnapshot(
          this.buildSnapshot(
            scope,
            date,
            realizedPnl,
            unrealized,
            tradeCount,
            ts,
          ),
        );

      await write(
        "global",
        realized.global,
        globalUnrealized,
        this.deps.getTradeCount(),
      );
      for (const [strategyId, realizedPnl] of realized.byStrategy) {
        await write(`strategy:${strategyId}`, realizedPnl, 0, 0);
      }
    } catch (error) {
      this.deps.onError(error, { where: "snapshot", date });
    }
  }

  private buildSnapshot(
    scope: string,
    date: string,
    realizedPnl: number,
    unrealized: number,
    tradeCount: number,
    ts: number,
  ): PnlSnapshot {
    return {
      scope,
      date,
      realizedPnl,
      unrealizedPnl: unrealized,
      equity: realizedPnl + unrealized,
      tradeCount,
      ts,
    };
  }
}
