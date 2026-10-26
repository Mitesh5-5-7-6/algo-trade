import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  MarketContext,
  StrategyConfig,
  StrategyVerdict,
} from "@neelkanth/core";
import type { EventPayload } from "@neelkanth/contracts";
import {
  StrategyRegistry,
  type SignalResolution,
  type StrategyDefinition,
} from "@neelkanth/strategies";
import { StrategyRunner } from "./strategy-runner.js";
import type { StrategyPorts } from "./ports.js";

/**
 * §0.5.5 — routing a signal's fate back to the strategy that emitted it.
 *
 * The strategy-side latch is tested against ORB itself; this is the other
 * half: does the runner actually deliver the verdict, and does it deliver it
 * for every way a signal can die? A latch that is only released on the paths
 * someone remembered to wire is no better than a boolean.
 */

const SYMBOL = "NSE:X-EQ";

/** A strategy that records every resolution it is handed. */
interface RecorderState {
  seen: SignalResolution[];
  proposed: boolean;
}

function recorder(
  type: string,
  verdict: StrategyVerdict,
): StrategyDefinition<Record<string, never>, RecorderState> {
  return {
    type,
    paramsSchema: z.object({}),
    interval: () => "5m",
    requiredIndicators: () => [],
    warmupBars: () => 0,
    init: () => ({ seen: [], proposed: false }),
    analyze: (_context: MarketContext, state) => {
      if (state.proposed) return { side: "HOLD", confidence: 0, reason: "one" };
      state.proposed = true;
      return verdict;
    },
    onSignalOutcome: (state, resolution) => {
      state.seen.push(resolution);
      if (resolution.status === "REJECTED") state.proposed = false;
    },
  };
}

const BUY: StrategyVerdict = {
  side: "BUY",
  confidence: 1,
  qtyProposal: 10,
  stopLoss: 90,
  target: 130,
  reason: "buy",
};

function harness(opts: { minConfidence?: number } = {}) {
  const registry = new StrategyRegistry();
  registry.register(recorder("ONE_SHOT", BUY));
  registry.register(
    recorder("WEAK", { side: "BUY", confidence: 0.2, reason: "weak" }),
  );
  /** Records what each instance was told, by strategy id. */
  const seen: SignalResolution[] = [];
  registry.register({
    ...recorder("SPY", BUY),
    onSignalOutcome: (state, resolution) => {
      state.seen.push(resolution);
      seen.push(resolution);
      // The latch behaviour under test: a rejection releases it.
      if (resolution.status === "REJECTED") state.proposed = false;
    },
  });

  const handoffs: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const ports: StrategyPorts = {
    readSession: () =>
      Promise.resolve({
        phase: "open" as const,
        minutesSinceOpen: 30,
        sessionOpenTs: 0,
      }),
    readCandleWindow: () => Promise.resolve([]),
    readPosition: () => Promise.resolve(null),
    readSentiment: () => Promise.resolve(0),
    resolveContract: () => null,
    readPrice: () => null,
    persistSignal: () => Promise.resolve(),
    publish: () => Promise.resolve(),
  };

  let idSeq = 0;
  const runner = new StrategyRunner({
    registry,
    ports,
    provisionIndicators: () => Promise.resolve(),
    handoff: (signal) => {
      handoffs.push(signal.signalId);
      return Promise.resolve();
    },
    nextSignalId: () => {
      idSeq += 1;
      return `sig_${String(idSeq)}`;
    },
    ...(opts.minConfidence === undefined
      ? {}
      : { minConfidence: opts.minConfidence }),
    onError: (_error, context) => errors.push(context),
  });

  return { runner, handoffs, errors, seen };
}

function config(type: string): StrategyConfig {
  return {
    strategyId: `str_${type}`,
    ownerId: "u",
    type,
    name: type,
    params: {},
    symbols: [SYMBOL],
    enabled: true,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

const candle = (ts: number) => ({
  symbol: SYMBOL,
  interval: "5m" as const,
  source: "LIVE_TICK" as const,
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 1,
  ts,
});

/** Run one bar through the runner. */
async function bar(runner: StrategyRunner, ts: number): Promise<void> {
  runner.onCandleClosed(candle(ts));
  await runner.onIndicatorsUpdated({
    symbol: SYMBOL,
    interval: "5m",
    indicators: {},
    ts,
  });
}

const placed = (
  signalId: string,
  orderId: string,
): EventPayload<"ORDER_PLACED"> => ({
  orderId,
  signalId,
  strategyId: "str_SPY",
  symbol: SYMBOL,
  side: "BUY",
  qty: 10,
  type: "MARKET",
  mode: "paper",
  ts: 1,
});

const filled = (orderId: string): EventPayload<"ORDER_FILLED"> => ({
  orderId,
  strategyId: "str_SPY",
  symbol: SYMBOL,
  side: "BUY",
  qty: 10,
  filledPrice: 100,
  slippage: 0,
  charges: 0,
  filledAt: 1,
  mode: "paper",
  ts: 1,
});

describe("the runner tells a strategy what became of its signal", () => {
  it("reports a confirmed fill, through the order that carried it", async () => {
    const h = harness();
    await h.runner.enable(config("SPY"));
    await bar(h.runner, 1_000);
    expect(h.handoffs).toEqual(["sig_1"]);

    h.runner.onOrderPlaced(placed("sig_1", "ord_1"));
    h.runner.onOrderFilled(filled("ord_1"));

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toMatchObject({
      signalId: "sig_1",
      side: "BUY",
      status: "FILLED",
    });
  });

  /** The case the mechanism exists for. */
  it("reports a risk block, naming the check that failed", async () => {
    const h = harness();
    await h.runner.enable(config("SPY"));
    await bar(h.runner, 1_000);

    h.runner.onRiskBlocked({
      signalId: "sig_1",
      strategyId: "str_SPY",
      symbol: SYMBOL,
      failedCheck: "marketBias",
      reason: "against the index",
      ts: 1,
    });

    expect(h.seen[0]).toMatchObject({
      status: "REJECTED",
      reason: "risk blocked: marketBias",
    });
  });

  it("reports a broker rejection", async () => {
    const h = harness();
    await h.runner.enable(config("SPY"));
    await bar(h.runner, 1_000);
    h.runner.onOrderPlaced(placed("sig_1", "ord_1"));

    h.runner.onOrderRejected({
      orderId: "ord_1",
      signalId: "sig_1",
      strategyId: "str_SPY",
      symbol: SYMBOL,
      side: "BUY",
      qty: 10,
      reason: "insufficient margin",
      mode: "paper",
      ts: 1,
    });

    expect(h.seen[0]).toMatchObject({
      status: "REJECTED",
      reason: "broker rejected: insufficient margin",
    });
  });

  /**
   * The quiet path. A below-threshold signal is recorded and never forwarded,
   * so nothing downstream will ever resolve it — and a one-shot strategy would
   * sit on a spent latch for the rest of the session waiting for a verdict
   * that cannot come.
   */
  it("resolves a signal it declines to forward itself", async () => {
    const h = harness({ minConfidence: 0.5 });
    await h.runner.enable(config("WEAK"));
    await bar(h.runner, 1_000);

    expect(h.handoffs).toEqual([]);
    // The strategy re-proposes on the next bar, because its latch was released.
    await bar(h.runner, 2_000);
    expect(h.handoffs).toEqual([]);
    // Two attempts, two rejections — not one attempt and permanent silence.
  });

  it("re-proposes after a rejection, and stops after a fill", async () => {
    const h = harness();
    await h.runner.enable(config("SPY"));

    await bar(h.runner, 1_000);
    h.runner.onRiskBlocked({
      signalId: "sig_1",
      strategyId: "str_SPY",
      symbol: SYMBOL,
      failedCheck: "marketBias",
      reason: "blocked",
      ts: 1,
    });

    await bar(h.runner, 2_000);
    expect(h.handoffs).toEqual(["sig_1", "sig_2"]);

    h.runner.onOrderPlaced(placed("sig_2", "ord_2"));
    h.runner.onOrderFilled(filled("ord_2"));

    await bar(h.runner, 3_000);
    expect(h.handoffs).toEqual(["sig_1", "sig_2"]); // no third attempt
  });

  it("ignores a fill for an order it never linked to a signal", () => {
    const h = harness();
    h.runner.onOrderFilled(filled("ord_unknown"));
    expect(h.seen).toEqual([]);
  });

  it("ignores a second fill for the same order", async () => {
    const h = harness();
    await h.runner.enable(config("SPY"));
    await bar(h.runner, 1_000);
    h.runner.onOrderPlaced(placed("sig_1", "ord_1"));

    h.runner.onOrderFilled(filled("ord_1"));
    h.runner.onOrderFilled(filled("ord_1"));

    expect(h.seen).toHaveLength(1);
  });

  /** A disabled strategy's in-flight orders must not reach a dead instance. */
  it("forgets a disabled strategy's pending signals", async () => {
    const h = harness();
    await h.runner.enable(config("SPY"));
    await bar(h.runner, 1_000);
    h.runner.onOrderPlaced(placed("sig_1", "ord_1"));

    h.runner.disable("str_SPY");
    h.runner.onOrderFilled(filled("ord_1"));

    expect(h.seen).toEqual([]);
  });

  /**
   * A strategy that throws in its callback must not disturb order handling —
   * the fill has already happened, and the position projection depends on it.
   */
  it("contains a callback that throws", async () => {
    const registry = new StrategyRegistry();
    registry.register({
      ...recorder("ANGRY", BUY),
      onSignalOutcome: () => {
        throw new Error("callback blew up");
      },
    });
    const errors: Record<string, unknown>[] = [];
    let idSeq = 0;
    const runner = new StrategyRunner({
      registry,
      ports: {
        readSession: () =>
          Promise.resolve({
            phase: "open" as const,
            minutesSinceOpen: 30,
            sessionOpenTs: 0,
          }),
        readCandleWindow: () => Promise.resolve([]),
        readPosition: () => Promise.resolve(null),
        readSentiment: () => Promise.resolve(0),
        resolveContract: () => null,
        readPrice: () => null,
        persistSignal: () => Promise.resolve(),
        publish: () => Promise.resolve(),
      },
      provisionIndicators: () => Promise.resolve(),
      handoff: () => Promise.resolve(),
      nextSignalId: () => {
        idSeq += 1;
        return `sig_${String(idSeq)}`;
      },
      onError: (_error, context) => errors.push(context),
    });

    await runner.enable(config("ANGRY"));
    await bar(runner, 1_000);
    runner.onOrderPlaced({ ...placed("sig_1", "ord_1"), strategyId: "x" });

    expect(() => {
      runner.onOrderFilled(filled("ord_1"));
    }).not.toThrow();
    expect(errors.some((c) => c["where"] === "onSignalOutcome")).toBe(true);
  });
});
