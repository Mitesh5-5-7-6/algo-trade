import { describe, expect, it } from "vitest";
import type { Position, SessionContext, Signal } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import { ExitEngine } from "./exit-engine.js";

const SYM = "NSE:X-EQ";
const OPEN_TS = 1_760_000_000_000;

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "pos_1",
    symbol: SYM,
    strategyId: "str_1",
    side: "LONG",
    qty: 10,
    avgEntryPrice: 100,
    status: "OPEN",
    realizedPnl: 0,
    unrealizedPnl: 0,
    stopLoss: 95,
    target: 110,
    openedAt: OPEN_TS,
    mode: "paper",
    ...overrides,
  };
}

function bar(
  high: number,
  low: number,
  close = (high + low) / 2,
): EventPayload<"CANDLE_CLOSED"> {
  return {
    symbol: SYM,
    interval: "5m",
    open: close,
    high,
    low,
    close,
    volume: 1,
    ts: OPEN_TS + 60_000,
  };
}

const session: SessionContext = {
  phase: "open",
  minutesSinceOpen: 30,
  sessionOpenTs: OPEN_TS,
};

function harness(open: Position[]) {
  const persisted: Signal[] = [];
  const handedOff: Signal[] = [];
  const errors: unknown[] = [];
  const engine = new ExitEngine({
    ports: {
      readOpenPositions: () => open,
      readSession: () => Promise.resolve(session),
      persistSignal: (signal) => {
        persisted.push(signal);
        return Promise.resolve();
      },
    },
    handoff: (signal) => {
      handedOff.push(signal);
      return Promise.resolve();
    },
    nextSignalId: (() => {
      let n = 0;
      return () => `sig_${String(++n)}`;
    })(),
    onError: (error) => errors.push(error),
  });
  return { engine, persisted, handedOff, errors };
}

describe("ExitEngine (plan/13, plan/14 §5)", () => {
  it("closes a LONG when the bar's low reaches the stop", async () => {
    const { engine, handedOff, persisted } = harness([position()]);
    await engine.onCandleClosed(bar(101, 94));
    expect(handedOff).toHaveLength(1);
    expect(handedOff[0]?.side).toBe("SELL");
    expect(handedOff[0]?.qtyProposal).toBe(10);
    expect(handedOff[0]?.reason).toBe("exit: stop");
    // Recorded before it was acted on — the audit trail, not a side effect.
    expect(persisted).toHaveLength(1);
  });

  it("closes a LONG when the bar's high reaches the target", async () => {
    const { engine, handedOff } = harness([position()]);
    await engine.onCandleClosed(bar(111, 99));
    expect(handedOff[0]?.reason).toBe("exit: target");
  });

  it("closes a SHORT on the mirrored levels", async () => {
    const short = position({ side: "SHORT", stopLoss: 105, target: 90 });
    const { engine, handedOff } = harness([short]);
    await engine.onCandleClosed(bar(106, 99));
    expect(handedOff[0]?.side).toBe("BUY");
    expect(handedOff[0]?.reason).toBe("exit: stop");
  });

  /**
   * An OHLC bar does not say which extreme came first. Assuming the target
   * would make every backtest optimistic in exactly the cases that hurt.
   */
  it("resolves a bar that touches both stop and target as the stop", async () => {
    const { engine, handedOff } = harness([position()]);
    await engine.onCandleClosed(bar(111, 94));
    expect(handedOff).toHaveLength(1);
    expect(handedOff[0]?.reason).toBe("exit: stop");
  });

  it("holds when the bar reaches neither level", async () => {
    const { engine, handedOff } = harness([position()]);
    await engine.onCandleClosed(bar(104, 97));
    expect(handedOff).toHaveLength(0);
  });

  it("ignores a position with no protective levels", async () => {
    const naked = position({ stopLoss: undefined, target: undefined });
    const { engine, handedOff } = harness([naked]);
    await engine.onCandleClosed(bar(999, 1));
    expect(handedOff).toHaveLength(0);
  });

  it("ignores bars for other symbols", async () => {
    const { engine, handedOff } = harness([position({ symbol: "NSE:Y-EQ" })]);
    await engine.onCandleClosed(bar(101, 94));
    expect(handedOff).toHaveLength(0);
  });

  it("does not exit the same position twice on a redelivered bar", async () => {
    const { engine, handedOff } = harness([position()]);
    await engine.onCandleClosed(bar(101, 94));
    await engine.onCandleClosed(bar(101, 94));
    expect(handedOff).toHaveLength(1);
  });

  it("flattens everything at the square-off, and only then", async () => {
    const flat = position({ stopLoss: undefined, target: undefined });
    const { engine, handedOff } = harness([flat]);
    const squareOff = OPEN_TS + 6 * 3_600_000;
    await engine.onSessionTick(squareOff - 60_000, squareOff);
    expect(handedOff).toHaveLength(0);
    await engine.onSessionTick(squareOff, squareOff);
    expect(handedOff).toHaveLength(1);
    expect(handedOff[0]?.reason).toBe("exit: square_off");
    expect(handedOff[0]?.side).toBe("SELL");
  });

  it("routes a handoff failure to onError rather than throwing", async () => {
    const errors: unknown[] = [];
    const engine = new ExitEngine({
      ports: {
        readOpenPositions: () => [position()],
        readSession: () => Promise.resolve(session),
        persistSignal: () => Promise.resolve(),
      },
      handoff: () => Promise.reject(new Error("risk unavailable")),
      nextSignalId: () => "sig_1",
      onError: (error) => errors.push(error),
    });
    await expect(engine.onCandleClosed(bar(101, 94))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
