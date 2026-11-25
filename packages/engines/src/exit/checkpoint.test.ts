import { describe, expect, it } from "vitest";
import type {
  CheckpointOddsTable,
  Position,
  SessionContext,
  Signal,
} from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import { ExitEngine } from "./exit-engine.js";

/**
 * The three-part target (PLAN.md 14.17) on the operator's own example:
 * NIFTY 25750 PE bought at ₹218.01, stop ₹163.46, target ₹348.72.
 * Thirds: T1 ₹261.58, T2 ₹305.15, T3 ₹348.72. One entry, never added to.
 */
const SYM = "NSE:NIFTY26D0125750PE";
const INDEX = "NSE:NIFTY50-INDEX";
/** The 11:10 IST bar of 2026-11-25: it closes at 11:15, two hours into the session. */
const BAR_TS = Date.UTC(2026, 10, 25, 5, 40);

const put: Position = {
  positionId: "pos_1",
  symbol: SYM,
  strategyId: "str_1",
  side: "LONG",
  qty: 325,
  avgEntryPrice: 218.01,
  status: "OPEN",
  realizedPnl: 0,
  unrealizedPnl: 0,
  stopLoss: 163.46,
  target: 348.72,
  openedAt: BAR_TS - 3_600_000,
  mode: "paper",
};

function bar(high: number, low: number): EventPayload<"CANDLE_CLOSED"> {
  return {
    symbol: SYM,
    interval: "5m",
    source: "LIVE_TICK",
    open: low,
    high,
    low,
    close: (high + low) / 2,
    volume: 1,
    ts: BAR_TS,
  };
}

/** One third = ₹43.57 of premium ≈ 87 index points at delta 0.5 ≈ 0.34% of 25,800. */
function table(chanceBack1: number, chanceBack2: number): CheckpointOddsTable {
  const row = (back: number, chance: number) => ({
    underlying: INDEX,
    direction: "DOWN" as const,
    fromMinute: 120,
    movePct: 0.003,
    back,
    samples: 200,
    chance,
  });
  return {
    builtAt: 0,
    sessions: 120,
    rows: [row(1, chanceBack1), row(2, chanceBack2)],
  };
}

function harness(position: Position, odds: CheckpointOddsTable | null) {
  const open = [position];
  const handedOff: Signal[] = [];
  const stops: number[] = [];
  const session: SessionContext = {
    phase: "open",
    minutesSinceOpen: 120,
    sessionOpenTs: BAR_TS - 7_200_000,
  };
  const engine = new ExitEngine({
    ports: {
      readOpenPositions: () => open,
      readSession: () => Promise.resolve(session),
      persistSignal: () => Promise.resolve(),
      hasExitInFlight: () => Promise.resolve(false),
      readExitRules: () => null,
      updateStopLoss: (_id, stop) => {
        stops.push(stop);
        if (open[0] !== undefined) open[0] = { ...open[0], stopLoss: stop };
        return Promise.resolve();
      },
      readCheckpointOdds: () => odds,
      readPrice: (s) => (s === INDEX ? 25_800 : null),
    },
    handoff: (signal) => {
      handedOff.push(signal);
      return Promise.resolve(undefined);
    },
    nextSignalId: () => "sig_x",
    onError: (e) => {
      throw e;
    },
  });
  return { engine, handedOff, stops };
}

describe("three-part target (14.17)", () => {
  it("sells everything at T1 when T2 is unlikely", async () => {
    const h = harness(put, table(0.25, 0.5));
    await h.engine.onCandleClosed(bar(262, 250)); // reaches T1 ₹261.58
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]).toMatchObject({
      side: "SELL",
      qtyProposal: 325, // all of it — one entry, one exit
      exitReason: "TAKE_PROFIT",
      reason: "exit: checkpoint T1, chance of T2 25%",
    });
  });

  it("holds all at T1 when T2 is likely, with the stop moved to the buy price", async () => {
    const h = harness(put, table(0.6, 0.5));
    await h.engine.onCandleClosed(bar(262, 250));
    expect(h.handedOff).toHaveLength(0);
    expect(h.stops).toEqual([218.01]);
  });

  it("judges T3 at T2, two parts back to the stop", async () => {
    const h = harness(put, table(0.6, 0.3));
    await h.engine.onCandleClosed(bar(262, 250)); // T1: hold
    await h.engine.onCandleClosed(bar(306, 290)); // T2 ₹305.15: T3 at 30%
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.reason).toBe("exit: checkpoint T2, chance of T3 30%");
  });

  it("holds when the table has no case for the move", async () => {
    const empty: CheckpointOddsTable = { builtAt: 0, sessions: 0, rows: [] };
    const h = harness(put, empty);
    await h.engine.onCandleClosed(bar(262, 250));
    expect(h.handedOff).toHaveLength(0);
    expect(h.stops).toEqual([218.01]); // still protected at the buy price
  });

  it("is off without a table: stop and target alone, as replay runs", async () => {
    const h = harness(put, null);
    await h.engine.onCandleClosed(bar(262, 250));
    expect(h.handedOff).toHaveLength(0);
    expect(h.stops).toEqual([]);
  });

  it("still takes the full target at T3", async () => {
    const h = harness(put, table(0.6, 0.6));
    await h.engine.onCandleClosed(bar(262, 250));
    await h.engine.onCandleClosed(bar(306, 290));
    await h.engine.onCandleClosed(bar(349, 330)); // T3 = target
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.reason).toBe("exit: target");
  });
});
