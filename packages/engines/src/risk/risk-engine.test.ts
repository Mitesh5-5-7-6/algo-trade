import { describe, expect, it } from "vitest";
import {
  UNKNOWN_MARKET_VIEW,
  type Instrument,
  type MarketBias,
  type MarketView,
  type Position,
  type RiskDecision,
  type RiskLimits,
  type RiskLog,
  type RiskRules,
  type SessionPhase,
  type Signal,
} from "@neelkanth/core";
import type { EventName } from "@neelkanth/contracts";
import { RiskEngine } from "./risk-engine.js";
import type { PortfolioSnapshot, RiskPorts } from "./ports.js";

const GLOBAL: RiskLimits = {
  maxDailyLoss: 5000,
  maxPositionSize: 100,
  maxCapitalPerTrade: 50000,
  maxOpenPositions: 5,
  maxExposure: 0.8,
  // With the default signal (price 100, stop 95 → ₹5/unit) and ₹100k
  // allocated, the risk budget is ₹1,000 → 200 units before any cap.
  riskPerTrade: 0.01,
};

function view(bias: MarketBias): MarketView {
  return { ...UNKNOWN_MARKET_VIEW, bias, detail: `test ${bias}` };
}

interface State {
  session: SessionPhase;
  dailyLoss: number;
  openCount: number;
  position: Position | null;
  inflight: boolean;
  portfolio: PortfolioSnapshot;
  global: RiskLimits;
  override: RiskRules | null;
  failReadSession: boolean;
  marketView: MarketView;
  instrument: Instrument | null;
}

function harness(init: Partial<State> = {}) {
  const state: State = {
    session: "open",
    dailyLoss: 0,
    openCount: 0,
    position: null,
    inflight: false,
    portfolio: {
      allocatedCapital: 100_000,
      investedValue: 0,
      availableCapital: 100_000,
    },
    global: GLOBAL,
    override: null,
    failReadSession: false,
    marketView: UNKNOWN_MARKET_VIEW, // NEUTRAL — blocks nothing
    instrument: null, // equity by symbol suffix → lot size 1
    ...init,
  };
  const logs: RiskLog[] = [];
  const events: { name: EventName; payload: unknown }[] = [];
  const errors: unknown[] = [];

  const ports: RiskPorts = {
    readSession: () =>
      state.failReadSession
        ? Promise.reject(new Error("redis down"))
        : Promise.resolve(state.session),
    readDailyRealizedLoss: () => Promise.resolve(state.dailyLoss),
    readOpenPositionCount: () => Promise.resolve(state.openCount),
    readPosition: () => Promise.resolve(state.position),
    hasInflightIntent: () => Promise.resolve(state.inflight),
    readPortfolio: () => Promise.resolve(state.portfolio),
    readGlobalLimits: () => Promise.resolve(state.global),
    readStrategyOverride: () => Promise.resolve(state.override),
    readMarketView: () => state.marketView,
    readInstrument: () => state.instrument,
    persistRiskLog: (log) => {
      logs.push(log);
      return Promise.resolve();
    },
    publish: (name, payload) => {
      events.push({ name, payload });
      return Promise.resolve();
    },
  };
  const engine = new RiskEngine({
    ports,
    onError: (error) => errors.push(error),
  });
  return { engine, state, logs, events, errors };
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    signalId: "sig_1",
    strategyId: "str_1",
    symbol: "NSE:X-EQ",
    side: "BUY",
    confidence: 1,
    qtyProposal: 10,
    // Sizing is risk-based, so a stop is a required input, not decoration.
    stopLoss: 95,
    reason: "test",
    contextSnapshot: {
      price: 100,
      indicators: {},
      session: "open",
      sentiment: 0,
    },
    ts: 1000,
    ...overrides,
  };
}

/**
 * The reason string off a blocked decision, narrowed.
 *
 * `expect.stringContaining` inside `toMatchObject` types as `any`, which the
 * lint rules reject — and rightly: it also silently passes if the decision
 * shape changes. Narrowing first asserts the block AND gives a typed reason.
 */
function blockedReason(decision: RiskDecision): string {
  if (decision.decision !== "blocked") {
    throw new Error(`expected a block, got ${decision.decision}`);
  }
  return decision.reason;
}

const longPosition: Position = {
  positionId: "pos_1",
  symbol: "NSE:X-EQ",
  strategyId: "str_1",
  side: "LONG",
  qty: 10,
  avgEntryPrice: 100,
  status: "OPEN",
  realizedPnl: 0,
  unrealizedPnl: 0,
  openedAt: 0,
  mode: "paper",
};

describe("RiskEngine — approval & logging (plan/14 §7)", () => {
  it("approves a clean signal and logs the decision with all checks", async () => {
    const h = harness();
    const decision = await h.engine.validate(signal());
    expect(decision.decision).toBe("approved");
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.decision).toBe("approved");
    expect(h.logs[0]?.checks.map((c) => c.check)).toEqual([
      "session",
      "duplicate",
      "marketBias",
      "dailyLoss",
      "positionSize",
    ]);
    expect(h.events).toHaveLength(0); // no RISK_BLOCKED on approval
  });
});

describe("RiskEngine — check 1 session (plan/14 §4.1)", () => {
  it("blocks when the market is not open, even for an exit", async () => {
    const h = harness({ session: "closed", position: longPosition });
    const decision = await h.engine.validate(signal({ side: "SELL" }));
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "session",
    });
    // Only the session check ran — it's first and absolute (plan/14 §4).
    expect(h.logs[0]?.checks).toHaveLength(1);
    expect(h.events[0]?.name).toBe("RISK_BLOCKED");
  });
});

describe("RiskEngine — check 2 duplicate (plan/14 §4.2)", () => {
  it("blocks an equivalent in-flight intent", async () => {
    const h = harness({ inflight: true });
    const decision = await h.engine.validate(signal());
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "duplicate",
    });
  });
});

describe("RiskEngine — check 3 daily loss (plan/14 §4.3)", () => {
  it("blocks a risk-increasing signal at the limit (boundary: loss ≥ limit)", async () => {
    const h = harness({ dailyLoss: 5000 });
    const decision = await h.engine.validate(signal());
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "dailyLoss",
    });
  });

  it("approves just under the limit", async () => {
    const h = harness({ dailyLoss: 4999 });
    expect((await h.engine.validate(signal())).decision).toBe("approved");
  });

  it("NEVER blocks an exit on the loss limit (asymmetry, plan/14 §5)", async () => {
    const h = harness({ dailyLoss: 999_999, position: longPosition });
    const decision = await h.engine.validate(signal({ side: "SELL" }));
    expect(decision.decision).toBe("approved");
    const dailyCheck = h.logs[0]?.checks.find((c) => c.check === "dailyLoss");
    expect(dailyCheck?.detail).toContain("exempt");
  });
});

describe("RiskEngine — check 3 market bias (plan/14 §4)", () => {
  it("blocks a BUY into a bearish market", async () => {
    const h = harness({ marketView: view("BEARISH") });
    const decision = await h.engine.validate(signal({ side: "BUY" }));
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "marketBias",
    });
  });

  it("blocks a SELL entry into a bullish market", async () => {
    const h = harness({ marketView: view("BULLISH") });
    const decision = await h.engine.validate(signal({ side: "SELL" }));
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "marketBias",
    });
  });

  it("allows a BUY into a bullish market", async () => {
    const h = harness({ marketView: view("BULLISH") });
    expect((await h.engine.validate(signal({ side: "BUY" }))).decision).toBe(
      "approved",
    );
  });

  /**
   * NEUTRAL means direction and participation disagree. Blocking both sides
   * there would halt trading on ambiguity rather than on evidence.
   */
  it("allows both sides when the market is neutral", async () => {
    const h = harness({ marketView: view("NEUTRAL") });
    expect((await h.engine.validate(signal({ side: "BUY" }))).decision).toBe(
      "approved",
    );
  });

  it("exempts an exit — getting out is allowed against any market", async () => {
    const h = harness({
      position: longPosition,
      marketView: view("BULLISH"), // a SELL would be blocked as an entry
    });
    const decision = await h.engine.validate(signal({ side: "SELL" }));
    expect(decision.decision).toBe("approved");
  });

  it("records the market read on the log even when it passes", async () => {
    const h = harness({ marketView: view("BULLISH") });
    await h.engine.validate(signal({ side: "BUY" }));
    const check = h.logs[0]?.checks.find((c) => c.check === "marketBias");
    expect(check?.passed).toBe(true);
    expect(check?.detail).toContain("BULLISH");
  });
});

describe("RiskEngine — check 5 risk-based sizing (plan/14 §4.4)", () => {
  /**
   * The headline behaviour: size follows the risk budget, not the strategy's
   * placeholder quantity. ₹100k × 1% = ₹1,000 risked ÷ ₹5 per unit = 200,
   * then capped by maxPositionSize 100.
   */
  it("sizes from the risk budget and the stop distance", async () => {
    const h = harness({ global: { ...GLOBAL, maxPositionSize: 1000 } });
    const decision = await h.engine.validate(signal({ qtyProposal: undefined }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 200 });
  });

  it("sizes larger on a tighter stop, for the same rupee risk", async () => {
    // Every other cap lifted, so the risk arithmetic is what binds.
    const h = harness({
      global: {
        ...GLOBAL,
        maxPositionSize: 10_000,
        maxCapitalPerTrade: 1_000_000,
        maxExposure: 1,
      },
    });
    // No qtyProposal — the strategy's placeholder would cap both at 10 and
    // hide the very effect under test.
    const wide = await h.engine.validate(
      signal({ stopLoss: 90, qtyProposal: undefined }), // ₹10/unit
    );
    const tight = await h.engine.validate(
      signal({ stopLoss: 99, qtyProposal: undefined }), // ₹1/unit
    );
    expect(wide).toEqual({ decision: "approved", cappedQty: 100 });
    expect(tight).toEqual({ decision: "approved", cappedQty: 1000 });
  });

  it("always reports the sized quantity, so the order never falls back to the proposal", async () => {
    const h = harness();
    const decision = await h.engine.validate(signal({ qtyProposal: 100 }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 100 });
  });

  it("treats qtyProposal as a ceiling on intent", async () => {
    const h = harness();
    const decision = await h.engine.validate(signal({ qtyProposal: 7 }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 7 });
  });

  it("blocks an entry with no stop — risk would be unnameable", async () => {
    const h = harness();
    const decision = await h.engine.validate(signal({ stopLoss: undefined }));
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "positionSize",
    });
    expect(blockedReason(decision)).toContain("stop");
  });

  it("blocks when the stop sits exactly on the entry", async () => {
    const h = harness();
    const decision = await h.engine.validate(signal({ stopLoss: 100 }));
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "positionSize",
    });
  });

  it("caps by per-trade capital", async () => {
    const h = harness({
      global: { ...GLOBAL, maxCapitalPerTrade: 5000 }, // price 100 → 50 units
    });
    const decision = await h.engine.validate(signal({ qtyProposal: 80 }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 50 });
  });

  it("caps by remaining exposure budget", async () => {
    const h = harness({
      portfolio: {
        allocatedCapital: 100_000,
        investedValue: 79_000, // budget = 0.8·100k − 79k = 1000 → 10 units @100
        availableCapital: 21_000,
      },
    });
    const decision = await h.engine.validate(signal({ qtyProposal: 50 }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 10 });
  });

  it("blocks a NEW position when max open positions is reached", async () => {
    const h = harness({ openCount: 5 }); // == maxOpenPositions
    const decision = await h.engine.validate(signal());
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "positionSize",
    });
  });

  it("blocks when there is no capacity at all", async () => {
    const h = harness({
      portfolio: {
        allocatedCapital: 100_000,
        investedValue: 0,
        availableCapital: 50, // < one unit at price 100
      },
    });
    const decision = await h.engine.validate(signal({ qtyProposal: 10 }));
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "positionSize",
    });
  });

  it("exempts an exit from the size check entirely (plan/14 §5)", async () => {
    const h = harness({
      position: longPosition,
      portfolio: {
        allocatedCapital: 100_000,
        investedValue: 100_000,
        availableCapital: 0,
      },
    });
    // No capacity, but it's an exit — approved anyway.
    const decision = await h.engine.validate(
      signal({ side: "SELL", qtyProposal: 10 }),
    );
    expect(decision.decision).toBe("approved");
  });

  it("honors a stricter per-strategy override", async () => {
    const h = harness({ override: { maxPositionSize: 20 } });
    const decision = await h.engine.validate(signal({ qtyProposal: 80 }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 20 });
  });

  it("honors a stricter per-strategy riskPerTrade", async () => {
    const h = harness({
      global: { ...GLOBAL, maxPositionSize: 1000 },
      override: { riskPerTrade: 0.005 }, // ₹500 ÷ ₹5 = 100
    });
    const decision = await h.engine.validate(signal({ qtyProposal: undefined }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 100 });
  });
});

describe("RiskEngine — lot rounding for derivatives (plan/17 §7)", () => {
  const future: Instrument = {
    symbol: "NSE:NIFTY26SEPFUT",
    kind: "FUTURE",
    lotSize: 75,
    tickSize: 0.05,
    underlying: "NIFTY",
    expiry: 4_000_000_000_000,
  };

  it("rounds DOWN to whole lots", async () => {
    const h = harness({
      instrument: future,
      global: { ...GLOBAL, maxPositionSize: 1000 },
    });
    // Risk allows 200 units; 200/75 = 2.67 lots → 2 lots = 150.
    const decision = await h.engine.validate(
      signal({ symbol: future.symbol, qtyProposal: undefined }),
    );
    expect(decision).toEqual({ decision: "approved", cappedQty: 150 });
  });

  it("blocks when a single lot does not fit the budget", async () => {
    const h = harness({
      instrument: { ...future, lotSize: 500 },
      global: { ...GLOBAL, maxPositionSize: 1000 },
    });
    const decision = await h.engine.validate(
      signal({ symbol: future.symbol, qtyProposal: undefined }),
    );
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "positionSize",
    });
    expect(blockedReason(decision)).toContain("lot");
  });

  /**
   * A wrong multiplier mis-sizes every order and does not fail loudly, so an
   * unknown derivative is refused rather than assumed to be lot size 1.
   */
  it("refuses a non-equity symbol missing from the master", async () => {
    const h = harness({ instrument: null });
    const decision = await h.engine.validate(
      signal({ symbol: "NSE:NIFTY26SEPFUT" }),
    );
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "positionSize",
    });
    expect(blockedReason(decision)).toContain("symbol master");
  });

  it("still sizes equity at lot 1 when the master is empty", async () => {
    const h = harness({ instrument: null });
    const decision = await h.engine.validate(signal({ symbol: "NSE:X-EQ" }));
    expect(decision.decision).toBe("approved");
  });
});

describe("RiskEngine — fail-closed (plan/14 §9)", () => {
  it("blocks and logs when risk state cannot be read", async () => {
    const h = harness({ failReadSession: true });
    const decision = await h.engine.validate(signal());
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "session",
    });
    expect(decision.decision === "blocked" && decision.reason).toContain(
      "fail closed",
    );
    expect(h.errors).toHaveLength(1);
  });
});
