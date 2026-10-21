import { describe, expect, it } from "vitest";
import type { ExitRules, Position, Signal } from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import { ExitEngine, type ExitHandoffOutcome } from "./exit-engine.js";

/**
 * Phase 3 — the exit lifecycle (docs/design/PHASE_3_EXIT_LIFECYCLE.md).
 *
 * Each block is one task's decision. They drive the real engine through fake
 * ports, because what is under test is the decision, not the persistence.
 */

const STRATEGY = "str_exit";
const SYMBOL = "NSE:EXIT-EQ";
const OPEN_TS = 1_000_000;

const position = (over: Partial<Position> = {}): Position => ({
  positionId: "pos_1",
  strategyId: STRATEGY,
  symbol: SYMBOL,
  side: "LONG",
  qty: 10,
  avgEntryPrice: 100,
  status: "OPEN",
  realizedPnl: 0,
  unrealizedPnl: 0,
  openedAt: OPEN_TS,
  mode: "paper",
  ...over,
});

const bar = (
  over: Partial<EventPayload<"CANDLE_CLOSED">> = {},
): EventPayload<"CANDLE_CLOSED"> => ({
  symbol: SYMBOL,
  interval: "5m",
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 1,
  ts: OPEN_TS,
  source: "LIVE_TICK",
  ...over,
});

function harness(options: {
  positions?: Position[];
  inFlight?: boolean;
  rules?: ExitRules | null;
  /** What each successive handoff reports; past the end, nothing. */
  outcomes?: (ExitHandoffOutcome | undefined)[];
}) {
  const handedOff: Signal[] = [];
  const errors: Record<string, unknown>[] = [];
  const stops: { positionId: string; stopLoss: number }[] = [];
  let live = options.positions ?? [position()];
  let lookups = 0;

  const engine = new ExitEngine({
    ports: {
      readOpenPositions: () => live,
      readSession: () =>
        Promise.resolve({
          phase: "open" as const,
          minutesSinceOpen: 10,
          sessionOpenTs: OPEN_TS,
        }),
      persistSignal: () => Promise.resolve(),
      hasExitInFlight: () => {
        lookups += 1;
        return Promise.resolve(options.inFlight ?? false);
      },
      readExitRules: () => options.rules ?? null,
      updateStopLoss: (positionId, stopLoss) => {
        stops.push({ positionId, stopLoss });
        live = live.map((p) =>
          p.positionId === positionId ? { ...p, stopLoss } : p,
        );
        return Promise.resolve();
      },
    },
    handoff: (signal) => {
      handedOff.push(signal);
      return Promise.resolve(options.outcomes?.[handedOff.length - 1]);
    },
    nextSignalId: () => `sig_${String(handedOff.length + 1)}`,
    onError: (_error, context) => errors.push(context),
  });

  return { engine, handedOff, errors, stops, lookups: () => lookups };
}

describe("the exit guard survives a restart (§3.1, D3)", () => {
  /**
   * The window: exit handed off, restart before the fill lands. The in-memory
   * Set is gone, the position is still open, and nothing else remembers. A
   * second exit is not a duplicate close — under Phase 2's Q1 it is a
   * REVERSAL, so it opens a phantom position facing the other way.
   */
  it("does not exit again when the store says one is already in flight", async () => {
    const h = harness({
      positions: [position({ stopLoss: 99 })],
      inFlight: true,
    });
    await h.engine.onCandleClosed(bar({ low: 98 }));

    expect(h.handedOff).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("exits when nothing is in flight, naming the position", async () => {
    const h = harness({ positions: [position({ stopLoss: 99 })] });
    await h.engine.onCandleClosed(bar({ low: 98 }));

    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.exitReason).toBe("STOP_LOSS");
    // Carried so the durable check has something to match on next time.
    expect(h.handedOff[0]?.positionId).toBe("pos_1");
  });

  /** A warm session must not pay for a read it does not need. */
  it("consults the store only until memory knows", async () => {
    const h = harness({ positions: [position({ stopLoss: 99 })] });
    await h.engine.onCandleClosed(bar({ low: 98 }));
    await h.engine.onCandleClosed(bar({ low: 97 }));

    expect(h.handedOff).toHaveLength(1);
    expect(h.lookups()).toBe(1);
  });
});

/**
 * Audit A7 (design §8): a blocked exit is retried.
 *
 * The engine marks a position as exiting BEFORE the handoff, so a second bar
 * cannot double-exit while the first is in flight. But the handoff can end in
 * no order at all — risk blocks it — and nothing ever cleared the mark: the
 * position sat open, with every later bar skipping it, until a restart. An
 * entry with no exit coming is the orphan Phase 3 exists to prevent.
 */
describe("a blocked exit is retried (§3.1, audit A7)", () => {
  it("tries again on the next bar when no order was placed", async () => {
    const h = harness({
      positions: [position({ stopLoss: 99 })],
      outcomes: [{ placed: false }],
    });
    await h.engine.onCandleClosed(bar({ low: 98 }));
    await h.engine.onCandleClosed(bar({ low: 97, ts: OPEN_TS + 300_000 }));

    expect(h.handedOff).toHaveLength(2);
  });

  it("does not try again once an order was placed", async () => {
    const h = harness({
      positions: [position({ stopLoss: 99 })],
      outcomes: [{ placed: true }],
    });
    await h.engine.onCandleClosed(bar({ low: 98 }));
    await h.engine.onCandleClosed(bar({ low: 97, ts: OPEN_TS + 300_000 }));

    expect(h.handedOff).toHaveLength(1);
  });

  /**
   * A handoff that reports nothing is treated as placed — the cautious
   * reading. Retrying on silence could send a second closing order while the
   * first is live, and under Phase 2's Q1 that is a reversal.
   */
  it("treats a handoff that reports nothing as placed", async () => {
    const h = harness({ positions: [position({ stopLoss: 99 })] });
    await h.engine.onCandleClosed(bar({ low: 98 }));
    await h.engine.onCandleClosed(bar({ low: 97, ts: OPEN_TS + 300_000 }));

    expect(h.handedOff).toHaveLength(1);
  });
});

/**
 * Task 3.4 (D2): a time exit, measured from the entry FILL to the moment the
 * decision is made — the bar's CLOSE. A bar's `ts` is its start, so judging
 * on it undercounted the hold by one bar (audit A6).
 */
describe("time exit (§3.4, D2)", () => {
  const MIN = 60_000;

  it("closes a position held past its limit, at the bar's close", async () => {
    const h = harness({ rules: { maxHoldMinutes: 15 } });
    // The 5m bar starting at +10m closes at +15m: fifteen minutes held.
    await h.engine.onCandleClosed(bar({ ts: OPEN_TS + 10 * MIN }));

    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.exitReason).toBe("TIME_EXIT");
  });

  it("leaves it alone one bar short", async () => {
    const h = harness({ rules: { maxHoldMinutes: 15 } });
    await h.engine.onCandleClosed(bar({ ts: OPEN_TS + 5 * MIN })); // closes +10m

    expect(h.handedOff).toEqual([]);
  });

  it("does nothing when no limit is configured", async () => {
    const h = harness({ rules: null });
    await h.engine.onCandleClosed(bar({ ts: OPEN_TS + 600 * MIN }));

    expect(h.handedOff).toEqual([]);
  });

  /** Q3 rule 4: stop, then target, then time. */
  it("reports a stop rather than a time exit when both are reached", async () => {
    const h = harness({
      positions: [position({ stopLoss: 99 })],
      rules: { maxHoldMinutes: 15 },
    });
    await h.engine.onCandleClosed(bar({ ts: OPEN_TS + 30 * MIN, low: 98 }));

    expect(h.handedOff[0]?.exitReason).toBe("STOP_LOSS");
  });
});

/**
 * Task 3.5 (D4) and design §5.1 Q3. A trailing stop is a stop: it reports
 * STOP_LOSS. And a bar is judged against the levels it OPENED with; the trail
 * moves after judging, for the next bar. Trailing first assumed the bar's high
 * came before its low — which OHLC does not say — and turned bars that took
 * profit into stop-outs (audit A1).
 */
describe("trailing stop (§3.5, D4, Q3)", () => {
  it("tightens the stop behind a favourable bar and persists it", async () => {
    const h = harness({
      positions: [position({ stopLoss: 95 })],
      rules: { trailingStopPct: 0.02 },
    });
    await h.engine.onCandleClosed(bar({ high: 110, low: 108, close: 109 }));

    expect(h.stops).toEqual([{ positionId: "pos_1", stopLoss: 107.8 }]);
    expect(h.handedOff).toEqual([]);
  });

  /** A stop that could loosen is not a stop. */
  it("never widens the stop on an adverse bar", async () => {
    const h = harness({
      positions: [position({ stopLoss: 108 })],
      rules: { trailingStopPct: 0.02 },
    });
    await h.engine.onCandleClosed(bar({ high: 101, low: 100, close: 100 }));

    expect(h.stops).toEqual([]);
  });

  /**
   * Q3 rules 1 and 2. The bar ran up to 110 and back down to 100: it is
   * judged against the 95 it opened with, so it does not stop out on a level
   * it set itself. The raised stop catches the NEXT bar.
   */
  it("judges a bar against the stop it opened with, then trails for the next", async () => {
    const h = harness({
      positions: [position({ stopLoss: 95 })],
      rules: { trailingStopPct: 0.02 },
    });
    await h.engine.onCandleClosed(bar({ high: 110, low: 100, close: 101 }));
    expect(h.handedOff).toEqual([]);
    expect(h.stops).toEqual([{ positionId: "pos_1", stopLoss: 107.8 }]);

    await h.engine.onCandleClosed(
      bar({ ts: OPEN_TS + 300_000, high: 108, low: 107, close: 107 }),
    );
    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.exitReason).toBe("STOP_LOSS");
  });

  /**
   * The design §5.1 bar. Only the target was touched against the levels the
   * bar opened with — and TAKE_PROFIT is the truth in either intrabar order.
   * Trailing first reported STOP_LOSS here.
   */
  it("reports the take-profit the bar actually reached", async () => {
    const h = harness({
      positions: [position({ stopLoss: 95, target: 110 })],
      rules: { trailingStopPct: 0.02 },
    });
    await h.engine.onCandleClosed(bar({ high: 111, low: 105, close: 108 }));

    expect(h.handedOff).toHaveLength(1);
    expect(h.handedOff[0]?.exitReason).toBe("TAKE_PROFIT");
  });

  it("mirrors for a SHORT", async () => {
    const h = harness({
      positions: [position({ side: "SHORT", stopLoss: 110 })],
      rules: { trailingStopPct: 0.02 },
    });
    await h.engine.onCandleClosed(bar({ high: 95, low: 90, close: 92 }));

    expect(h.stops[0]?.stopLoss).toBeCloseTo(91.8, 6);
    expect(h.handedOff).toEqual([]);
  });
});

/**
 * Task 3.6 (D6): square-off is opt-out, per strategy. The default is the
 * decision: an intraday system that silently began holding overnight because
 * a config was absent carries gap risk nobody chose. Opting out changes only
 * the flatten — the daily-loss gate is the Risk Engine's and is untouched
 * (design Q4: almost certainly not, and it is not).
 */
describe("square-off is opt-out, per strategy (§3.6, D6)", () => {
  const SQUARE_OFF = OPEN_TS + 6 * 3_600_000;

  it("flattens by default", async () => {
    const h = harness({ rules: null });
    await h.engine.onSessionTick(SQUARE_OFF, SQUARE_OFF);

    expect(h.handedOff[0]?.exitReason).toBe("SESSION_CLOSE");
  });

  it("flattens when exit rules exist but say nothing about it", async () => {
    const h = harness({ rules: { maxHoldMinutes: 600 } });
    await h.engine.onSessionTick(SQUARE_OFF, SQUARE_OFF);

    expect(h.handedOff).toHaveLength(1);
  });

  it("leaves a strategy that opted out alone", async () => {
    const h = harness({ rules: { squareOffAtSessionEnd: false } });
    await h.engine.onSessionTick(SQUARE_OFF, SQUARE_OFF);

    expect(h.handedOff).toEqual([]);
  });

  /** Holding overnight declines the flatten, not the protection. */
  it("still honours stops for a strategy that holds overnight", async () => {
    const h = harness({
      positions: [position({ stopLoss: 99 })],
      rules: { squareOffAtSessionEnd: false },
    });
    await h.engine.onCandleClosed(bar({ low: 98 }));

    expect(h.handedOff[0]?.exitReason).toBe("STOP_LOSS");
  });
});
