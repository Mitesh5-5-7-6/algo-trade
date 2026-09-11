import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  DerivativeTarget,
  Instrument,
  MarketContext,
  Position,
  SessionContext,
  Signal,
  StrategyConfig,
  StrategyVerdict,
} from "@neelkanth/core";
import type { EventName } from "@neelkanth/contracts";
import {
  StrategyRegistry,
  type StrategyDefinition,
} from "@neelkanth/strategies";
import { StrategyRunner } from "./strategy-runner.js";
import type { StrategyPorts } from "./ports.js";

const EmptyParams = z.object({});

function def(
  type: string,
  analyze: (c: MarketContext) => StrategyVerdict,
  required: StrategyDefinition<
    unknown,
    unknown
  >["requiredIndicators"] = () => [],
): StrategyDefinition<Record<string, never>, Record<string, never>> {
  return {
    type,
    paramsSchema: EmptyParams,
    interval: () => "5m",
    requiredIndicators: required,
    warmupBars: () => 0,
    init: () => ({}),
    analyze,
  };
}

const buy: StrategyVerdict = {
  side: "BUY",
  confidence: 1,
  qtyProposal: 10,
  stopLoss: 90,
  target: 130,
  reason: "test buy",
};

function harness(opts: { minConfidence?: number; maxErrors?: number } = {}) {
  const registry = new StrategyRegistry();
  registry.register(def("ALWAYS_BUY", () => buy));
  registry.register(
    def("HOLDER", () => ({
      side: "HOLD",
      confidence: 0,
      reason: "waiting",
    })),
  );
  registry.register(
    def(
      "NEEDS_EMA",
      () => buy,
      () => [{ kind: "ema", period: 5 }],
    ),
  );
  registry.register(
    def("LOW_CONF", () => ({
      side: "BUY",
      confidence: 0.2,
      reason: "weak",
    })),
  );
  registry.register(
    def("THROWS", () => {
      throw new Error("strategy blew up");
    }),
  );
  // Analyses one series, trades a contract derived from another — the split
  // the derivative path exists to handle.
  registry.register({
    ...def("OPTION_BUYER", () => ({
      side: "BUY",
      confidence: 1,
      stopLossPct: 0.3,
      targetPct: 0.6,
      reason: "index breakout",
    })),
    derivative: () => ({
      underlying: "NIFTY",
      kind: "OPTION" as const,
      strikeOffset: 0,
    }),
  });

  const signals: Signal[] = [];
  const events: { name: EventName; payload: unknown }[] = [];
  const handoffs: Signal[] = [];
  const errors: { error: unknown; context: Record<string, unknown> }[] = [];
  const provisioned: { symbol: string; specs: unknown }[] = [];
  let session: SessionContext = {
    phase: "open",
    minutesSinceOpen: 30,
    sessionOpenTs: 0,
  };
  let position: Position | null = null;
  /** Contract the fake master resolves to; null means "cannot be resolved". */
  let contract: Instrument | null = null;
  /** Price the fake feed reports for the resolved contract. */
  let contractPrice: number | null = null;
  const resolved: { target: DerivativeTarget; side: string; spot: number }[] =
    [];

  const ports: StrategyPorts = {
    readSession: () => Promise.resolve(session),
    readCandleWindow: () => Promise.resolve([]),
    readPosition: () => Promise.resolve(position),
    readSentiment: () => Promise.resolve(0),
    resolveContract: (target, side, spot) => {
      resolved.push({ target, side, spot });
      return contract;
    },
    readPrice: () => contractPrice,
    persistSignal(signal) {
      signals.push(signal);
      return Promise.resolve();
    },
    publish(name, payload) {
      events.push({ name, payload });
      return Promise.resolve();
    },
  };

  let idSeq = 0;
  const runner = new StrategyRunner({
    registry,
    ports,
    provisionIndicators: (symbol, _interval, specs) => {
      provisioned.push({ symbol, specs });
      return Promise.resolve();
    },
    handoff: (signal) => {
      handoffs.push(signal);
      return Promise.resolve();
    },
    nextSignalId: () => {
      idSeq += 1;
      return `sig_${String(idSeq)}`;
    },
    ...(opts.minConfidence === undefined
      ? {}
      : { minConfidence: opts.minConfidence }),
    ...(opts.maxErrors === undefined ? {} : { maxErrors: opts.maxErrors }),
    onError: (error, context) => errors.push({ error, context }),
  });

  return {
    runner,
    signals,
    events,
    handoffs,
    errors,
    provisioned,
    resolved,
    setSession: (s: SessionContext) => (session = s),
    setPosition: (p: Position | null) => (position = p),
    setContract: (c: Instrument | null, price: number | null) => {
      contract = c;
      contractPrice = price;
    },
  };
}

function config(type: string, symbols = ["NSE:X-EQ"]): StrategyConfig {
  return {
    strategyId: `str_${type}`,
    ownerId: "u",
    type,
    name: type,
    params: {},
    symbols,
    enabled: true,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

const candle = (close: number, ts = 1000) => ({
  symbol: "NSE:X-EQ",
  interval: "5m" as const,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  ts,
});
const indicators = (values: Record<string, number>, ts = 1000) => ({
  symbol: "NSE:X-EQ",
  interval: "5m",
  indicators: values,
  ts,
});

async function fireBar(
  h: ReturnType<typeof harness>,
  close: number,
  values: Record<string, number> = {},
  ts = 1000,
) {
  h.runner.onCandleClosed(candle(close, ts));
  await h.runner.onIndicatorsUpdated(indicators(values, ts));
}

describe("StrategyRunner enable/disable (plan/15 §4)", () => {
  it("provisions indicators on enable and throws on an unknown type", async () => {
    const h = harness();
    await h.runner.enable(config("NEEDS_EMA"));
    expect(h.provisioned).toHaveLength(1);
    expect(h.provisioned[0]?.specs).toEqual([{ kind: "ema", period: 5 }]);

    await expect(h.runner.enable(config("GHOST"))).rejects.toThrow(
      /unknown strategy type/,
    );
  });

  it("stops running a disabled strategy", async () => {
    const h = harness();
    await h.runner.enable(config("ALWAYS_BUY"));
    h.runner.disable("str_ALWAYS_BUY");
    await fireBar(h, 150);
    expect(h.signals).toHaveLength(0);
  });
});

describe("StrategyRunner decision path (plan/15 §4, §6)", () => {
  it("records a BUY, emits SIGNAL_CREATED, and hands off synchronously", async () => {
    const h = harness();
    await h.runner.enable(config("ALWAYS_BUY"));
    await fireBar(h, 150);

    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.side).toBe("BUY");
    expect(h.signals[0]?.contextSnapshot.price).toBe(150);
    expect(h.events.filter((e) => e.name === "SIGNAL_CREATED")).toHaveLength(1);
    expect(h.handoffs).toHaveLength(1);
  });

  it("records a HOLD but never forwards it (plan/15 §4)", async () => {
    const h = harness();
    await h.runner.enable(config("HOLDER"));
    await fireBar(h, 150);
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.side).toBe("HOLD");
    expect(h.handoffs).toHaveLength(0);
  });

  it("records but does not forward a sub-threshold signal (plan/15 §6)", async () => {
    const h = harness({ minConfidence: 0.5 });
    await h.runner.enable(config("LOW_CONF"));
    await fireBar(h, 150);
    expect(h.signals).toHaveLength(1);
    expect(h.handoffs).toHaveLength(0);
  });
});

describe("StrategyRunner gating (plan/15 §4, plan/18 §4)", () => {
  it("does not analyze until required indicators are ready", async () => {
    const h = harness();
    await h.runner.enable(config("NEEDS_EMA"));
    await fireBar(h, 150, {}); // ema5 absent → skipped
    expect(h.signals).toHaveLength(0);
    await fireBar(h, 150, { ema5: 148 }, 2000); // ready
    expect(h.signals).toHaveLength(1);
  });

  it("does not decide when the market is not open", async () => {
    const h = harness();
    await h.runner.enable(config("ALWAYS_BUY"));
    h.setSession({ phase: "closed", minutesSinceOpen: -10, sessionOpenTs: 0 });
    await fireBar(h, 150);
    expect(h.signals).toHaveLength(0);
  });

  it("ignores an indicator update that doesn't match the cached bar", async () => {
    const h = harness();
    await h.runner.enable(config("ALWAYS_BUY"));
    h.runner.onCandleClosed(candle(150, 1000));
    await h.runner.onIndicatorsUpdated(indicators({}, 9999)); // ts mismatch
    expect(h.signals).toHaveLength(0);
  });
});

describe("StrategyRunner isolation (plan/15 §7)", () => {
  it("contains a throwing analyze and auto-disables after repeated failures", async () => {
    const h = harness({ maxErrors: 2 });
    await h.runner.enable(config("THROWS"));

    await fireBar(h, 150, {}, 1000);
    await fireBar(h, 150, {}, 2000);
    expect(h.errors).toHaveLength(2);
    expect(h.errors[1]?.context["errored"]).toBe(true);

    // Now errored: further bars are skipped, no more errors accrue.
    await fireBar(h, 150, {}, 3000);
    expect(h.errors).toHaveLength(2);
    expect(h.signals).toHaveLength(0);
  });
});

describe("StrategyRunner derivative resolution (plan/15 §4, plan/17 §7)", () => {
  const NIFTY_CE: Instrument = {
    symbol: "NSE:NIFTY26SEP25000CE",
    kind: "OPTION",
    lotSize: 65,
    tickSize: 0.05,
    underlying: "NIFTY",
    expiry: 4_000_000_000_000,
    strike: 25_000,
    optionType: "CE",
  };

  function derivativeHarness() {
    const h = harness();
    return h;
  }

  it("trades the resolved CONTRACT, priced at the contract — not the index", async () => {
    const h = derivativeHarness();
    h.setContract(NIFTY_CE, 150);
    await h.runner.enable(config("OPTION_BUYER"));
    await fireBar(h, 25_012); // index level

    const signal = h.signals[0];
    expect(signal?.symbol).toBe("NSE:NIFTY26SEP25000CE");
    // The audit trail keeps what was analysed.
    expect(signal?.underlyingSymbol).toBe("NSE:X-EQ");
    // Sizing divides a risk budget by this. The index level would misprice
    // the position by two orders of magnitude.
    expect(signal?.contextSnapshot.price).toBe(150);
    expect(h.handoffs).toHaveLength(1);
  });

  it("resolves percentage stops against the premium, not the index", async () => {
    const h = derivativeHarness();
    h.setContract(NIFTY_CE, 150);
    await h.runner.enable(config("OPTION_BUYER"));
    await fireBar(h, 25_012);

    expect(h.signals[0]?.stopLoss).toBeCloseTo(105, 6); // 150 × (1 − 0.3)
    expect(h.signals[0]?.target).toBeCloseTo(240, 6); // 150 × (1 + 0.6)
  });

  it("passes the index spot and the side to the resolver", async () => {
    const h = derivativeHarness();
    h.setContract(NIFTY_CE, 150);
    await h.runner.enable(config("OPTION_BUYER"));
    await fireBar(h, 25_012);

    expect(h.resolved[0]?.spot).toBe(25_012);
    expect(h.resolved[0]?.side).toBe("BUY");
    expect(h.resolved[0]?.target.underlying).toBe("NIFTY");
  });

  /**
   * An index has no tradable contract, so falling back to the analysed symbol
   * would place an order the broker is certain to reject.
   */
  it("does not forward when the contract cannot be resolved", async () => {
    const h = derivativeHarness();
    h.setContract(null, null);
    await h.runner.enable(config("OPTION_BUYER"));
    await fireBar(h, 25_012);

    expect(h.handoffs).toHaveLength(0);
    // Recorded, so the evaluation is not lost — silence would read as
    // "the strategy never ran".
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.side).toBe("HOLD");
    expect(h.signals[0]?.reason).toContain("contract unresolved");
    expect(h.errors).toHaveLength(1);
  });

  it("does not forward a resolved contract that has no price yet", async () => {
    const h = derivativeHarness();
    h.setContract(NIFTY_CE, null); // resolved, never ticked
    await h.runner.enable(config("OPTION_BUYER"));
    await fireBar(h, 25_012);

    expect(h.handoffs).toHaveLength(0);
    expect(h.signals[0]?.side).toBe("HOLD");
  });

  it("reports its derivative targets so the runtime can subscribe them", async () => {
    const h = derivativeHarness();
    await h.runner.enable(config("OPTION_BUYER"));
    expect(h.runner.derivativeTargets()).toEqual([
      {
        symbol: "NSE:X-EQ",
        target: { underlying: "NIFTY", kind: "OPTION", strikeOffset: 0 },
      },
    ]);
  });

  it("leaves an ordinary strategy trading what it analysed", async () => {
    const h = derivativeHarness();
    await h.runner.enable(config("ALWAYS_BUY"));
    await fireBar(h, 150);
    expect(h.signals[0]?.symbol).toBe("NSE:X-EQ");
    expect(h.signals[0]?.underlyingSymbol).toBeUndefined();
    expect(h.resolved).toHaveLength(0);
  });
});
