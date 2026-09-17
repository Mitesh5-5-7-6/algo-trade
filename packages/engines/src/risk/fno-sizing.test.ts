import { describe, expect, it } from "vitest";
import {
  UNKNOWN_MARKET_VIEW,
  type Instrument,
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
import {
  capitalPerLotFor,
  resolveFnoLimits,
  sizeFno,
  toFnoSizingLog,
} from "./sizing.js";
import type { PortfolioSnapshot, RiskPorts } from "./ports.js";

/**
 * F&O sizing is in LOTS, not shares (plan/14 §4.4).
 *
 * The regression these guard: sizing used to compute a share capacity first
 * and floor a lot out of it, so a NIFTY signal with capacity for 44 "units"
 * was refused with "one lot of 60 does not fit in 44" — a sentence that names
 * neither the binding budget nor the shortfall. Capacities are now computed in
 * lots from the start and the smallest wins.
 *
 * The worked example throughout: premium ₹100, stop ₹110, lot 65.
 *   riskPerLot    = |100 − 110| × 65 = ₹650
 *   capitalPerLot = 100 × 65         = ₹6,500
 */

const LOT = 65;

const OPTION: Instrument = {
  symbol: "NSE:NIFTY2591625500CE",
  kind: "OPTION",
  lotSize: LOT,
  tickSize: 0.05,
  underlying: "NIFTY",
  strike: 25_500,
  optionType: "CE",
};

/** ₹100k allocated; F&O budget 2% = ₹2,000 → 3 lots by risk at ₹650/lot. */
const LIMITS: RiskLimits = {
  maxDailyLoss: 5_000,
  maxPositionSize: 100,
  maxCapitalPerTrade: 50_000,
  maxOpenPositions: 5,
  maxExposure: 0.8,
  riskPerTrade: 0.01,
  fnoRiskPerTrade: 0.02,
  fnoMaxCapitalPerTrade: 50_000,
  fnoMaxExposure: 0.8,
  fnoMaxOpenPositions: 3,
};

const PORTFOLIO: PortfolioSnapshot = {
  allocatedCapital: 100_000,
  investedValue: 0,
  availableCapital: 100_000,
};

function size(
  overrides: {
    limits?: Partial<RiskLimits>;
    portfolio?: Partial<PortfolioSnapshot>;
    entryPrice?: number;
    stopPrice?: number;
    instrument?: Instrument;
    openPositionCount?: number;
    opensNewPosition?: boolean;
  } = {},
) {
  return sizeFno({
    symbol: OPTION.symbol,
    instrument: overrides.instrument ?? OPTION,
    entryPrice: overrides.entryPrice ?? 100,
    stopPrice: overrides.stopPrice ?? 110,
    portfolio: { ...PORTFOLIO, ...overrides.portfolio },
    limits: resolveFnoLimits({ ...LIMITS, ...overrides.limits }),
    openPositionCount: overrides.openPositionCount ?? 0,
    opensNewPosition: overrides.opensNewPosition ?? true,
  });
}

describe("F&O sizing — lots are the unit (plan/14 §4.4)", () => {
  it("1. sizes exactly one lot when exactly one fits", () => {
    // Budget ₹700 → 1.07 lots at ₹650/lot.
    const result = size({ limits: { fnoRiskPerTrade: 0.007 } });

    expect(result.riskPerLot).toBe(650);
    expect(result.capitalPerLot).toBe(6_500);
    expect(result.lotsByRisk).toBe(1);
    expect(result.allowedLots).toBe(1);
    expect(result.quantity).toBe(LOT);
    expect(result.blockedReason).toBeNull();
  });

  it("2. blocks when one lot does not fit the risk budget", () => {
    // ₹600 budget against ₹650 of risk in a single lot. Changing the unit from
    // shares to lots does not make a ₹650 trade cost ₹600.
    const result = size({ limits: { fnoRiskPerTrade: 0.006 } });

    expect(result.lotsByRisk).toBe(0);
    expect(result.allowedLots).toBe(0);
    expect(result.quantity).toBe(0);
    expect(result.blockedReason).toContain("ONE LOT EXCEEDS RISK BUDGET");
    // The message names both sides, not an arithmetic remainder.
    expect(result.blockedReason).toContain("₹650");
    expect(result.blockedReason).toContain("₹600");
  });

  it("3. blocks when one lot fits the risk budget but not the capital limit", () => {
    // Risk allows 3 lots; ₹5,000 of capital cannot fund even one ₹6,500 lot.
    const result = size({ limits: { fnoMaxCapitalPerTrade: 5_000 } });

    expect(result.lotsByRisk).toBe(3);
    expect(result.lotsByCapital).toBe(0);
    expect(result.allowedLots).toBe(0);
    expect(result.quantity).toBe(0);
    expect(result.blockedReason).toContain("may be committed to one F&O trade");
  });

  it("4. takes multiple lots when every capacity allows it", () => {
    // Risk ₹2,000/₹650 = 3; capital ₹50,000/₹6,500 = 7; exposure 80,000/6,500 = 12.
    const result = size();

    expect(result.lotsByRisk).toBe(3);
    expect(result.lotsByCapital).toBe(7);
    expect(result.lotsByExposure).toBe(12);
    expect(result.allowedLots).toBe(3);
    expect(result.quantity).toBe(3 * LOT);
  });

  it("5. lets the exposure limit reduce the allowed lots", () => {
    // Exposure headroom ₹13,000 → 2 lots, below the risk capacity of 3.
    const result = size({
      limits: { fnoMaxExposure: 0.8 },
      portfolio: { investedValue: 67_000 },
    });

    expect(result.lotsByRisk).toBe(3);
    expect(result.lotsByExposure).toBe(2);
    expect(result.allowedLots).toBe(2);
    expect(result.quantity).toBe(2 * LOT);
  });

  it("6. lets the max-lots-per-trade limit reduce the allowed lots", () => {
    const result = size({ limits: { fnoMaxLotsPerTrade: 2 } });

    expect(result.lotsByRisk).toBe(3);
    expect(result.lotsByMaxLotsPerTrade).toBe(2);
    expect(result.allowedLots).toBe(2);
    expect(result.quantity).toBe(2 * LOT);
  });

  it("7. blocks when zero lots are allowed", () => {
    const result = size({
      limits: { fnoRiskPerTrade: 0.001 }, // ₹100 budget vs ₹650/lot
    });

    expect(result.allowedLots).toBe(0);
    expect(result.quantity).toBe(0);
    expect(result.blockedReason).not.toBeNull();
  });

  it("8. never produces a partial lot, at any capacity", () => {
    // Every budget from ₹0 to ₹5,000 in ₹50 steps must yield a whole multiple
    // of the lot size — a fractional capacity may round down, never across.
    for (let budget = 0; budget <= 5_000; budget += 50) {
      const result = size({
        limits: { fnoRiskPerTrade: budget / PORTFOLIO.allocatedCapital },
      });
      expect(Number.isInteger(result.allowedLots)).toBe(true);
      expect(result.quantity % LOT).toBe(0);
      expect(result.quantity).toBe(result.allowedLots * LOT);
      // 1.9 lots of capacity is one lot, never two.
      expect(result.allowedLots).toBeLessThanOrEqual(budget / 650);
    }
  });

  it("blocks a new position at the F&O open-position cap", () => {
    const result = size({ openPositionCount: 3, opensNewPosition: true });

    expect(result.lotsByMaxOpenPositions).toBe(0);
    expect(result.allowedLots).toBe(0);
    expect(result.blockedReason).toContain("open F&O positions 3 ≥ max 3");
  });

  it("converts a strategy's contract proposal into whole lots", () => {
    // 130 contracts = 2 lots exactly; 129 is one lot, not 1.98.
    expect(size({}).allowedLots).toBe(3);
    const proposed = sizeFno({
      symbol: OPTION.symbol,
      instrument: OPTION,
      entryPrice: 100,
      stopPrice: 110,
      portfolio: PORTFOLIO,
      limits: resolveFnoLimits(LIMITS),
      openPositionCount: 0,
      opensNewPosition: true,
      qtyProposal: 129,
    });
    expect(proposed.lotsByProposal).toBe(1);
    expect(proposed.quantity).toBe(LOT);
  });

  it("falls back to the equity budget rather than inventing a wider one", () => {
    const withoutFno: RiskLimits = { ...LIMITS };
    delete withoutFno.fnoRiskPerTrade;
    const resolved = resolveFnoLimits(withoutFno);

    expect(resolved.riskPerTrade).toBe(LIMITS.riskPerTrade);
    expect(resolved.maxLotsPerTrade).toBeNull();
  });

  it("refuses to size when the stop equals the entry", () => {
    const result = size({ entryPrice: 100, stopPrice: 100 });

    expect(result.allowedLots).toBe(0);
    expect(result.blockedReason).toContain("undefined risk per lot");
  });
});

// --- Engine-level: the daily-loss gate around F&O entries and exits ---------

interface State {
  session: SessionPhase;
  dailyLoss: number;
  openCount: number;
  position: Position | null;
  portfolio: PortfolioSnapshot;
  global: RiskLimits;
  instrument: Instrument | null;
  marketView: MarketView;
}

function harness(init: Partial<State> = {}) {
  const state: State = {
    session: "open",
    dailyLoss: 0,
    openCount: 0,
    position: null,
    portfolio: PORTFOLIO,
    global: LIMITS,
    instrument: OPTION,
    marketView: UNKNOWN_MARKET_VIEW,
    ...init,
  };
  const logs: RiskLog[] = [];
  const events: { name: EventName; payload: unknown }[] = [];
  const ports: RiskPorts = {
    readSession: () => Promise.resolve(state.session),
    readDailyRealizedLoss: () => Promise.resolve(state.dailyLoss),
    readOpenPositionCount: () => Promise.resolve(state.openCount),
    readPosition: () => Promise.resolve(state.position),
    hasInflightIntent: () => Promise.resolve(false),
    readPortfolio: () => Promise.resolve(state.portfolio),
    readGlobalLimits: () => Promise.resolve(state.global),
    readStrategyOverride: (): Promise<RiskRules | null> =>
      Promise.resolve(null),
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
  return {
    engine: new RiskEngine({ ports, onError: () => undefined }),
    state,
    logs,
  };
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    signalId: "sig_fno",
    strategyId: "str_1",
    symbol: OPTION.symbol,
    side: "BUY",
    confidence: 1,
    stopLoss: 110,
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

function blockedReason(decision: RiskDecision): string {
  if (decision.decision !== "blocked") {
    throw new Error(`expected a block, got ${decision.decision}`);
  }
  return decision.reason;
}

const openLong: Position = {
  positionId: "pos_1",
  symbol: OPTION.symbol,
  strategyId: "str_1",
  side: "LONG",
  qty: LOT,
  avgEntryPrice: 100,
  status: "OPEN",
  realizedPnl: 0,
  unrealizedPnl: 0,
  openedAt: 1,
  mode: "paper",
};

describe("F&O and the daily-loss gate (plan/14 §4.3, §5)", () => {
  it("9. blocks a new F&O entry once the daily loss limit is reached", async () => {
    const h = harness({ dailyLoss: 5_000 });

    const decision = await h.engine.validate(signal());

    expect(decision.decision).toBe("blocked");
    expect(blockedReason(decision)).toContain("daily realized loss");
  });

  it("10. still lets an existing F&O position exit after the daily loss limit", async () => {
    // Same breached limit, but a SELL against an open LONG is risk-reducing:
    // when limits are breached the machine may still get out, never in.
    const h = harness({ dailyLoss: 5_000, position: openLong });

    const decision = await h.engine.validate(signal({ side: "SELL" }));

    expect(decision.decision).toBe("approved");
  });
});

describe("F&O risk decisions are logged in full (plan/14 §7)", () => {
  it("records the lot arithmetic on an approval", async () => {
    const h = harness();

    await h.engine.validate(signal());

    const sizing = h.logs[0]?.fnoSizing;
    expect(sizing).toBeDefined();
    expect(sizing).toMatchObject({
      symbol: OPTION.symbol,
      lotSize: LOT,
      entryPrice: 100,
      stopPrice: 110,
      stopDistance: 10,
      riskPerLot: 650,
      capitalPerLot: 6_500,
      riskBudget: 2_000,
      riskCapacityLots: 3,
      allowedLots: 3,
      finalQuantity: 3 * LOT,
      blockedReason: null,
    });
  });

  it("records which capacity bound on a block", async () => {
    const h = harness({
      global: { ...LIMITS, fnoRiskPerTrade: 0.006 },
    });

    const decision = await h.engine.validate(signal());

    expect(blockedReason(decision)).toContain("ONE LOT EXCEEDS RISK BUDGET");
    expect(h.logs[0]?.fnoSizing).toMatchObject({
      riskCapacityLots: 0,
      allowedLots: 0,
      finalQuantity: 0,
    });
    expect(h.logs[0]?.fnoSizing?.blockedReason).toContain("one lot risks ₹650");
  });

  it("sizes equity in shares and attaches no lot arithmetic", async () => {
    const h = harness({ instrument: null });

    const decision = await h.engine.validate(
      signal({ symbol: "NSE:RELIANCE-EQ", stopLoss: 95 }),
    );

    // Risk allows 200 shares (₹1,000 ÷ ₹5); maxPositionSize 100 binds first.
    expect(decision).toEqual({ decision: "approved", cappedQty: 100 });
    expect(h.logs[0]?.fnoSizing).toBeUndefined();
  });
});

describe("F&O capital basis is explicit per instrument class", () => {
  const FUTURE: Instrument = {
    symbol: "NSE:NIFTY25SEPFUT",
    kind: "FUTURE",
    lotSize: LOT,
    tickSize: 0.05,
    underlying: "NIFTY",
  };

  it("labels an option's capital as the premium actually paid", () => {
    const result = size();

    expect(result.instrumentType).toBe("OPTION");
    expect(result.capitalBasis).toBe("PREMIUM");
    expect(result.capitalPerLot).toBe(100 * LOT);
  });

  /**
   * The distinction that must not be lost: a future's `capitalPerLot` is the
   * contract notional, not the margin posted. Sizing against the full notional
   * can only make a position smaller than margin would allow — never larger —
   * which is the safe direction to be wrong in while no margin data exists.
   */
  it("labels a future's capital as notional, not margin", () => {
    const result = size({
      instrument: FUTURE,
      entryPrice: 25_000,
      stopPrice: 24_900,
    });

    expect(result.instrumentType).toBe("FUTURE");
    expect(result.capitalBasis).toBe("NOTIONAL");
    expect(result.capitalPerLot).toBe(25_000 * LOT);
  });

  it("invents no margin percentage — notional is used as-is", () => {
    const entry = 25_000;
    const { capitalPerLot, basis } = capitalPerLotFor("FUTURE", entry, LOT);

    // Any haircut here would be fabricated precision, so there is none.
    expect(capitalPerLot).toBe(entry * LOT);
    expect(basis).toBe("NOTIONAL");
  });

  it("carries the basis into the persisted decision", () => {
    expect(toFnoSizingLog(size())).toMatchObject({
      instrumentType: "OPTION",
      capitalBasis: "PREMIUM",
    });
  });
});

describe("F&O limits resolve to an effective budget, for step-up comparison", () => {
  /**
   * The control plane decides whether a settings change needs step-up re-auth
   * by asking whether the EFFECTIVE budget grew. Comparing raw fields would
   * miss both cases below, because in each the F&O field and the equity field
   * disagree about what is actually in force.
   */
  it("treats setting an absent limit above the inherited one as a loosening", () => {
    const inheriting: RiskLimits = { ...LIMITS };
    delete inheriting.fnoRiskPerTrade; // inherits riskPerTrade = 1%
    const explicit: RiskLimits = { ...LIMITS, fnoRiskPerTrade: 0.02 };

    expect(resolveFnoLimits(inheriting).riskPerTrade).toBe(0.01);
    expect(resolveFnoLimits(explicit).riskPerTrade).toBe(0.02);
  });

  it("treats clearing a tighter limit back to inheritance as a loosening", () => {
    const tight: RiskLimits = { ...LIMITS, fnoRiskPerTrade: 0.005 };
    const cleared: RiskLimits = { ...LIMITS };
    delete cleared.fnoRiskPerTrade; // falls back to the looser 1%

    expect(resolveFnoLimits(tight).riskPerTrade).toBe(0.005);
    expect(resolveFnoLimits(cleared).riskPerTrade).toBe(0.01);
  });

  it("reports an absent lot ceiling as unbounded, the loosest value", () => {
    const capped: RiskLimits = { ...LIMITS, fnoMaxLotsPerTrade: 2 };
    const uncapped: RiskLimits = { ...LIMITS };

    expect(resolveFnoLimits(capped).maxLotsPerTrade).toBe(2);
    expect(resolveFnoLimits(uncapped).maxLotsPerTrade).toBeNull();
  });
});

describe("regression: the reported 'one lot of 60 does not fit in 44' block", () => {
  /**
   * The original failure, reproduced with the reported worked example:
   * FINNIFTY, lot 60, premium ₹150, stop ₹170.
   *
   * Under the old share-based path the engine computed a capacity of ~50
   * SHARES from a ₹1,000 budget (₹1,000 ÷ ₹20/share), then floored a 60-share
   * lot out of it and reported "one lot of 60 does not fit in 50". The number
   * was arithmetically true and operationally useless: it named neither the
   * budget nor the shortfall, and it implied the problem was rounding when the
   * problem was the budget.
   */
  const FINNIFTY: Instrument = {
    symbol: "NSE:FINNIFTY2591625550CE",
    kind: "OPTION",
    lotSize: 60,
    tickSize: 0.05,
    underlying: "FINNIFTY",
    strike: 25_550,
    optionType: "CE",
  };

  const finnifty = (fnoRiskPerTrade: number) =>
    sizeFno({
      symbol: FINNIFTY.symbol,
      instrument: FINNIFTY,
      entryPrice: 150,
      stopPrice: 170,
      portfolio: PORTFOLIO,
      limits: resolveFnoLimits({ ...LIMITS, fnoRiskPerTrade }),
      openPositionCount: 0,
      opensNewPosition: true,
    });

  it("still blocks when one lot genuinely exceeds the budget — changing units is not a loophole", () => {
    const result = finnifty(0.01); // ₹1,000 budget

    // One lot risks ₹20 × 60 = ₹1,200 against a ₹1,000 budget. Sizing in lots
    // does not turn a ₹1,200 trade into a ₹1,000 one, and must not pretend to.
    expect(result.riskPerLot).toBe(1_200);
    expect(result.riskBudget).toBe(1_000);
    expect(result.allowedLots).toBe(0);
    expect(result.quantity).toBe(0);
  });

  it("explains the block in budget terms instead of a leftover share count", () => {
    const reason = finnifty(0.01).blockedReason ?? "";

    expect(reason).toContain("one lot risks ₹1200");
    expect(reason).toContain("risk budget is ₹1000");
    expect(reason).toContain("ONE LOT EXCEEDS RISK BUDGET");
    // The old framing is gone: nothing compares a lot against a share capacity.
    expect(reason).not.toContain("does not fit in");
  });

  it("trades exactly one whole lot once the F&O budget covers one lot's risk", () => {
    const result = finnifty(0.02); // ₹2,000 budget → 1.67 lots

    expect(result.lotsByRisk).toBe(1);
    expect(result.allowedLots).toBe(1);
    expect(result.quantity).toBe(60); // one lot, not 1.67 lots' worth
    expect(result.blockedReason).toBeNull();
  });

  it("never reports a capacity in shares, at any budget", () => {
    // Whatever the budget, the answer is a lot count and a whole-lot quantity.
    for (const bps of [50, 100, 200, 400, 800]) {
      const result = finnifty(bps / 10_000);
      expect(result.quantity % FINNIFTY.lotSize).toBe(0);
      expect(result.quantity).toBe(result.allowedLots * FINNIFTY.lotSize);
    }
  });
});
