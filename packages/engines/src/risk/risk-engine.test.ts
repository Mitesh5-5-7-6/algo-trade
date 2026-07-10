import { describe, expect, it } from "vitest";
import type {
  Position,
  RiskLimits,
  RiskLog,
  RiskRules,
  SessionPhase,
  Signal,
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
};

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

describe("RiskEngine — check 4 size / exposure (plan/14 §4.4)", () => {
  it("caps (never invents) the proposed quantity to the position-size limit", async () => {
    const h = harness();
    const decision = await h.engine.validate(signal({ qtyProposal: 250 }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 100 });
  });

  it("does not cap a proposal already within limits", async () => {
    const h = harness();
    const decision = await h.engine.validate(signal({ qtyProposal: 100 }));
    expect(decision).toEqual({ decision: "approved" });
  });

  it("caps by per-trade capital", async () => {
    const h = harness({
      global: { ...GLOBAL, maxCapitalPerTrade: 5000 }, // price 100 → 50 shares
    });
    const decision = await h.engine.validate(signal({ qtyProposal: 80 }));
    expect(decision).toEqual({ decision: "approved", cappedQty: 50 });
  });

  it("caps by remaining exposure budget", async () => {
    const h = harness({
      portfolio: {
        allocatedCapital: 100_000,
        investedValue: 79_000, // budget = 0.8·100k − 79k = 1000 → 10 shares @100
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
        availableCapital: 50, // < one share at price 100
      },
    });
    const decision = await h.engine.validate(signal({ qtyProposal: 10 }));
    expect(decision).toMatchObject({
      decision: "blocked",
      failedCheck: "positionSize",
    });
  });

  it("blocks a risk-increasing signal with no proposed quantity", async () => {
    const h = harness();
    const decision = await h.engine.validate(
      signal({ qtyProposal: undefined }),
    );
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
