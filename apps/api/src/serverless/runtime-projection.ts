import type {
  Position,
  RiskLimits,
  SessionContext,
  StrategyConfig,
} from "@neelkanth/core";
import {
  SessionManager,
  startOfDayIST,
  type EquityPoint,
} from "@neelkanth/engines";
import { PositionsRepository, SettingsRepository } from "@neelkanth/db";
import { controlChannel } from "@neelkanth/redis";
import type { Db } from "mongodb";
import type { Redis } from "ioredis";
import type { RuntimeControls } from "../control-plane/controls.js";

/**
 * A {@link RuntimeControls} that reads from the DURABLE record instead of a
 * live engine (plan/05 §4 seam).
 *
 * The control plane was written against a running `EngineRuntime` — in-memory
 * positions, PnL counters, an equity sampler. Serverless has none of that: the
 * process is created per request and dies. So this stands in the same socket
 * and answers from Mongo + Redis, which is where the engines persist their
 * work anyway.
 *
 * WHAT THIS HONESTLY CANNOT DO
 * ----------------------------
 * The write methods (`setTradingEnabled`, `enableStrategy`, `disableStrategy`,
 * `applyGlobalSettings`) exist on the interface to push a change into a LIVE
 * engine's memory. There is no live engine here. Every one of those calls is
 * already preceded by the route persisting the change (`settings.setTrading-
 * Enabled`, `strategies.setEnabled`, …), so the durable state is correct and a
 * booting engine reads it. What is missing is the immediate effect on an
 * already-running engine.
 *
 * Rather than pretend, each write publishes on `control:commands` so a running
 * engine can honor it live. NOTE: no engine subscribes to that channel today —
 * the subscriber is not built. Until it is, a control action taken here binds
 * on the next engine boot, not instantly. This is documented rather than
 * hidden because a "pause" that silently does not pause is the single most
 * dangerous lie this system could tell (plan/12 §4).
 *
 * `RuntimeControls` is synchronous by design (it was reading memory), so the
 * state it serves is prefetched by {@link refresh} before each request.
 */

/** IST is UTC+5:30; the exchange calendar is defined in local wall-clock. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function parseHHMM(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function istMinuteOfDay(now: number): number {
  const ist = new Date(now + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** One request's worth of engine state, read from the durable record. */
interface Snapshot {
  openPositions: Position[];
  realizedPnl: number;
  unrealizedPnl: number;
  session: SessionContext;
}

const EMPTY: Snapshot = {
  openPositions: [],
  realizedPnl: 0,
  unrealizedPnl: 0,
  session: { phase: "closed", minutesSinceOpen: -1 },
};

export interface RuntimeProjection extends RuntimeControls {
  /** Re-read the durable state. Call once per request, before routing. */
  refresh(now: number): Promise<void>;
}

export function createRuntimeProjection(
  db: Db,
  redis: Redis,
): RuntimeProjection {
  const positions = new PositionsRepository(db);
  const settings = new SettingsRepository(db);
  let snapshot: Snapshot = EMPTY;

  /**
   * Fire-and-forget notification to a live engine, if one is listening. The
   * publish is awaited nowhere: `RuntimeControls`' write methods are `void`,
   * and a control action must not fail because Redis hiccuped — the durable
   * write the route already made is what actually counts.
   */
  const notify = (command: string, payload: unknown): void => {
    void redis
      .publish(controlChannel(), JSON.stringify({ command, payload }))
      .catch(() => {
        // Swallowed deliberately: there is no request to fail and no engine
        // guaranteed to be listening. The durable state is already correct.
      });
  };

  return {
    async refresh(now) {
      // Concurrent: the three reads are independent, and this runs on the
      // critical path of every dashboard request.
      const [global, openPositions, realizedByStrategy] = await Promise.all([
        settings.getGlobal(),
        positions.findOpen(),
        positions.sumRealizedByStrategySince(startOfDayIST(now)),
      ]);

      // Session phase is pure clock + calendar arithmetic, so it is computed
      // with the same SessionManager the engine uses rather than guessed —
      // identical market hours in, identical phase out.
      const sessionManager = new SessionManager({
        preOpen: "09:00",
        open: global.marketHours.open,
        close: global.marketHours.close,
        holidays: [],
        exchange: "NSE",
      });

      let realized = 0;
      for (const value of realizedByStrategy.values()) realized += value;
      let unrealized = 0;
      for (const position of openPositions) unrealized += position.unrealizedPnl;

      snapshot = {
        openPositions,
        realizedPnl: realized,
        unrealizedPnl: unrealized,
        session: {
          // `phase`, not `evaluate`: evaluate advances edge-tracking state and
          // would fabricate transitions across unrelated invocations.
          phase: sessionManager.phase(now),
          minutesSinceOpen:
            istMinuteOfDay(now) - parseHHMM(global.marketHours.open),
        },
      };
    },

    getOpenPositions: () => snapshot.openPositions,
    realizedPnl: () => snapshot.realizedPnl,
    unrealizedPnl: () => snapshot.unrealizedPnl,
    session: () => snapshot.session,

    /**
     * Always empty. The day curve is an in-memory sample series the running
     * engine builds minute by minute (plan/06 §4); nothing samples it here, and
     * an invented curve would be worse than a blank chart (plan/17 §5). The
     * durable per-day history is unaffected and still served by /pnl/history.
     */
    equityCurve: (): readonly EquityPoint[] => [],

    setTradingEnabled(enabled) {
      notify("setTradingEnabled", { enabled });
    },
    enableStrategy(config: StrategyConfig) {
      notify("enableStrategy", { strategyId: config.strategyId });
      return Promise.resolve();
    },
    disableStrategy(strategyId) {
      notify("disableStrategy", { strategyId });
    },
    applyGlobalSettings(next: {
      limits: RiskLimits;
      allocatedCapital: number;
    }) {
      notify("applyGlobalSettings", next);
    },
  };
}
