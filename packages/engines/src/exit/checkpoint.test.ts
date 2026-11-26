import { describe, expect, it } from "vitest";
import type {
  CheckpointOddsRow,
  CheckpointOddsTable,
  PivotLevels,
  Position,
  SessionContext,
  Signal,
} from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import { ExitEngine } from "./exit-engine.js";

/**
 * The three-part target and its stop-side mirror (PLAN.md 14.17, 14.19) on
 * the operator's own example: NIFTY 25750 PE bought at ₹218.01, stop ₹163.46,
 * target ₹348.72. One entry, never added to, never partly sold.
 *
 *   T1 261.58 · T2 305.15 · T3 348.72     (a part of 43.57)
 *   SL1 199.83 · SL2 181.64 · stop 163.46 (a part of 18.18)
 */
const SYM = "NSE:NIFTY26D0125750PE";
const INDEX = "NSE:NIFTY50-INDEX";
/** The 11:10 IST bar of 2026-11-25: it closes at 11:15, two hours into the session. */
const BAR_TS = Date.UTC(2026, 10, 25, 5, 40);
const HOUR = 3_600_000;

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
  openedAt: BAR_TS - HOUR,
  mode: "paper",
};

function bar(
  high: number,
  low: number,
  ts = BAR_TS,
): EventPayload<"CANDLE_CLOSED"> {
  return {
    symbol: SYM,
    interval: "5m",
    source: "LIVE_TICK",
    open: low,
    high,
    low,
    close: (high + low) / 2,
    volume: 1,
    ts,
  };
}

/**
 * Rows for the put's index (DOWN = a bought put gains). A target part of
 * 43.57 is ~0.34% of 25,800 at delta 0.5 (grid 0.3%); a stop part of 18.18
 * is ~0.14% (grid 0.15%).
 */
function row(
  movePct: number,
  back: number,
  chance: number,
  fromMinute = 120,
): CheckpointOddsRow {
  return {
    underlying: INDEX,
    direction: "DOWN",
    fromMinute,
    movePct,
    back,
    samples: 200,
    chance,
  };
}
const table = (...rows: CheckpointOddsRow[]): CheckpointOddsTable => ({
  builtAt: 0,
  sessions: 120,
  rows,
});

function harness(
  position: Position,
  odds: CheckpointOddsTable | null,
  pivots: PivotLevels | null = null,
) {
  const open = [position];
  const handedOff: Signal[] = [];
  const stops: number[] = [];
  const targets: number[] = [];
  const session: SessionContext = {
    phase: "open",
    minutesSinceOpen: 120,
    sessionOpenTs: BAR_TS - 2 * HOUR,
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
      updateTarget: (_id, target) => {
        targets.push(target);
        if (open[0] !== undefined) open[0] = { ...open[0], target };
        return Promise.resolve();
      },
      readCheckpointOdds: () => odds,
      readPrice: (s) => (s === INDEX ? 25_800 : null),
      readPivots: () => pivots,
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
  return { engine, handedOff, stops, targets };
}

describe("three-part target (14.17) with the stop rule (14.19 rule 2)", () => {
  it("sells everything at T1 when T2 is unlikely", async () => {
    const h = harness(put, table(row(0.003, 1, 0.25)));
    await h.engine.onCandleClosed(bar(262, 250)); // reaches T1 ₹261.58
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]).toMatchObject({
      side: "SELL",
      qtyProposal: 325, // all of it — one entry, one exit
      exitReason: "TAKE_PROFIT",
      reason: "exit: checkpoint T1, chance of T2 25%",
    });
  });

  it("holds at T1 when T2 is likely, the stop a little above the buy price", async () => {
    const h = harness(put, table(row(0.003, 1, 0.6)));
    await h.engine.onCandleClosed(bar(262, 250));
    expect(h.handedOff).toHaveLength(0);
    // 218.01 + 10% of a part (4.36): a fall back exits in profit.
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0]).toBeCloseTo(222.37, 2);
  });

  it("holds at T2 with the stop a little above T1, and judges T3 there", async () => {
    // 11:15 likely; 12:15 not.
    const h = harness(
      put,
      table(row(0.003, 1, 0.6), row(0.003, 1, 0.3, 180)),
    );
    await h.engine.onCandleClosed(bar(262, 250)); // T1: hold
    await h.engine.onCandleClosed(bar(306, 290, BAR_TS + HOUR)); // T2: 30%
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.reason).toBe(
      "exit: checkpoint T2, chance of T3 30%",
    );
  });

  it("moves the stop to a little above T1 when it holds at T2", async () => {
    const h = harness(put, table(row(0.003, 1, 0.6)));
    await h.engine.onCandleClosed(bar(262, 250)); // T1: hold
    await h.engine.onCandleClosed(bar(306, 290)); // T2: hold
    expect(h.handedOff).toHaveLength(0);
    expect(h.stops[1]).toBeCloseTo(265.94, 2); // 261.58 + 4.36
  });

  it("holds when the table has no case, and still protects at T1", async () => {
    const h = harness(put, table());
    await h.engine.onCandleClosed(bar(262, 250));
    expect(h.handedOff).toHaveLength(0);
    expect(h.stops[0]).toBeCloseTo(222.37, 2);
  });

  it("is off without a table: stop and target alone, as replay runs", async () => {
    const h = harness(put, null);
    await h.engine.onCandleClosed(bar(262, 250));
    await h.engine.onCandleClosed(bar(200, 180));
    expect(h.handedOff).toHaveLength(0);
    expect(h.stops).toEqual([]);
  });

  it("still takes the full target at T3", async () => {
    const h = harness(put, table(row(0.003, 1, 0.6)));
    await h.engine.onCandleClosed(bar(262, 250));
    await h.engine.onCandleClosed(bar(306, 290));
    await h.engine.onCandleClosed(bar(349, 330)); // T3 = target
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.reason).toBe("exit: target");
  });
});

describe("the stop side (14.19 rule 1)", () => {
  it("exits at SL1 when a bounce back to the buy price is unlikely", async () => {
    const h = harness(put, table(row(0.0015, 2, 0.3)));
    await h.engine.onCandleClosed(bar(215, 199)); // crosses SL1 ₹199.83
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]).toMatchObject({
      exitReason: "STOP_LOSS",
      reason: "exit: SL1 crossed, chance of a bounce 30%",
    });
  });

  it("waits at SL1 when a bounce is likely, then exits at SL2 if not", async () => {
    const h = harness(put, table(row(0.0015, 2, 0.7), row(0.0015, 1, 0.35)));
    await h.engine.onCandleClosed(bar(215, 199)); // SL1: 70%, wait
    expect(h.handedOff).toHaveLength(0);
    await h.engine.onCandleClosed(bar(195, 181)); // SL2 ₹181.64: 35%
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.reason).toBe(
      "exit: SL2 crossed, chance of a bounce 35%",
    );
  });

  it("judges each stop level once, not on every bar below it", async () => {
    const h = harness(put, table(row(0.0015, 2, 0.7)));
    await h.engine.onCandleClosed(bar(215, 199));
    await h.engine.onCandleClosed(bar(210, 198));
    await h.engine.onCandleClosed(bar(208, 197));
    expect(h.handedOff).toHaveLength(0);
  });

  it("leaves the final stop to the ordinary stop check", async () => {
    const h = harness(put, table(row(0.0015, 2, 0.7), row(0.0015, 1, 0.7)));
    await h.engine.onCandleClosed(bar(200, 163)); // through the stop
    expect(h.handedOff[0]?.reason).toBe("exit: stop");
  });
});

describe("a rebound trade (14.19 rule 3)", () => {
  // The index at 25,800; R1 25,850 → within 0.25%: a put bought at
  // resistance, after a rise, is a rebound trade.
  const pivots: PivotLevels = { pivot: 25_700, s1: 25_550, r1: 25_850 };
  const fresh: Position = { ...put, openedAt: BAR_TS };

  it("makes T1 the final target", async () => {
    const h = harness(fresh, table(row(0.003, 1, 0.9)), pivots);
    await h.engine.onCandleClosed(bar(230, 215)); // first bar: judged
    expect(h.targets).toHaveLength(1);
    expect(h.targets[0]).toBeCloseTo(261.58, 2);
    await h.engine.onCandleClosed(bar(262, 250)); // reaches T1 = target
    expect(h.handedOff[0]?.reason).toBe("exit: target");
  });

  it("is not a rebound away from the pivot", async () => {
    const far: PivotLevels = { pivot: 25_500, s1: 25_300, r1: 26_200 };
    const h = harness(fresh, table(row(0.003, 1, 0.9)), far);
    await h.engine.onCandleClosed(bar(230, 215));
    expect(h.targets).toEqual([]);
  });

  it("is judged only near the fill, not on a position held an hour", async () => {
    const h = harness(put, table(row(0.003, 1, 0.9)), pivots);
    await h.engine.onCandleClosed(bar(230, 215));
    expect(h.targets).toEqual([]);
  });
});
