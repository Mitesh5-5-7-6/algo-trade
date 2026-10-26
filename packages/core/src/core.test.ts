import { describe, expect, it } from "vitest";
import {
  BrokerOrderRequestSchema,
  CandleSchema,
  CANDLE_SOURCE_RANK,
  ConfidenceSchema,
  ExecutionOutcomeSchema,
  hasTrustedVolume,
  OrderSchema,
  ORDER_TERMINAL_STATUSES,
  PositionSchema,
  QuantitySchema,
  RiskDecisionSchema,
  SignalSchema,
  StrategyConfigSchema,
  StrategyVerdictSchema,
  TickSchema,
} from "./index.js";

const ts = 1_730_000_000_000;

const validSignal = {
  signalId: "sig_1",
  strategyId: "str_1",
  symbol: "NSE:RELIANCE-EQ",
  side: "BUY",
  confidence: 0.7,
  qtyProposal: 10,
  stopLoss: 2900,
  target: 3100,
  reason: "fast EMA 9 crossed above slow EMA 21",
  contextSnapshot: {
    price: 2999.5,
    indicators: { ema9: 3000.1, ema21: 2998.4 },
    session: "open",
    sentiment: 0,
  },
  ts,
};

describe("primitives", () => {
  it("rejects confidence outside [0,1]", () => {
    expect(ConfidenceSchema.safeParse(1.01).success).toBe(false);
    expect(ConfidenceSchema.safeParse(-0.01).success).toBe(false);
    expect(ConfidenceSchema.safeParse(0).success).toBe(true);
    expect(ConfidenceSchema.safeParse(1).success).toBe(true);
  });

  it("rejects zero, negative, and fractional quantities", () => {
    expect(QuantitySchema.safeParse(0).success).toBe(false);
    expect(QuantitySchema.safeParse(-5).success).toBe(false);
    expect(QuantitySchema.safeParse(1.5).success).toBe(false);
    expect(QuantitySchema.safeParse(10).success).toBe(true);
  });
});

describe("market shapes", () => {
  it("parses a valid tick and rejects a non-positive price", () => {
    const tick = { symbol: "NSE:INFY-EQ", ltp: 1500.5, volume: 100, ts };
    expect(TickSchema.safeParse(tick).success).toBe(true);
    expect(TickSchema.safeParse({ ...tick, ltp: 0 }).success).toBe(false);
  });

  it("rejects a candle with an unknown interval", () => {
    const candle = {
      symbol: "NSE:INFY-EQ",
      interval: "2m",
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      ts,
    };
    expect(CandleSchema.safeParse(candle).success).toBe(false);
    expect(CandleSchema.safeParse({ ...candle, interval: "5m" }).success).toBe(
      true,
    );
  });

  /**
   * Every candle already in Mongo predates provenance, and all of them came
   * from tick aggregation. `CandlesRepository.loadRecent` parses every document
   * it reads and indicator warm-up reads on every boot — so a required `source`
   * would have thrown on the first read after deploy.
   */
  it("defaults a stored candle with no provenance to LIVE_TICK", () => {
    const legacy = {
      symbol: "NSE:INFY-EQ",
      interval: "5m",
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      ts,
    };
    const parsed = CandleSchema.parse(legacy);
    expect(parsed.source).toBe("LIVE_TICK");
    expect(parsed.ingestedAt).toBeUndefined();
  });

  it("keeps an explicit provenance and rejects an unknown one", () => {
    const bar = {
      symbol: "NSE:INFY-EQ",
      interval: "5m",
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      ts,
    };
    expect(
      CandleSchema.parse({ ...bar, source: "BROKER_HISTORICAL" }).source,
    ).toBe("BROKER_HISTORICAL");
    expect(
      CandleSchema.safeParse({ ...bar, source: "GUESSWORK" }).success,
    ).toBe(false);
  });

  /**
   * Precedence, not alphabetical order: a backfill may overwrite our
   * aggregation, never the reverse. One (symbol, interval, ts) is one candle.
   */
  it("ranks the broker's record above ours, and replay below everything", () => {
    expect(CANDLE_SOURCE_RANK.BROKER_HISTORICAL).toBeGreaterThan(
      CANDLE_SOURCE_RANK.IMPORTED_DATA,
    );
    expect(CANDLE_SOURCE_RANK.IMPORTED_DATA).toBeGreaterThan(
      CANDLE_SOURCE_RANK.LIVE_TICK,
    );
    expect(CANDLE_SOURCE_RANK.LIVE_TICK).toBeGreaterThan(
      CANDLE_SOURCE_RANK.REPLAY,
    );
  });
});

describe("signal shapes", () => {
  it("parses a valid signal", () => {
    expect(SignalSchema.safeParse(validSignal).success).toBe(true);
  });

  it("rejects a signal missing its mandatory reason (plan/15 §2)", () => {
    expect(SignalSchema.safeParse({ ...validSignal, reason: "" }).success).toBe(
      false,
    );
  });

  it("rejects a context sentiment outside the clamp [-1, 1] (plan/20 §3)", () => {
    const bad = {
      ...validSignal,
      contextSnapshot: { ...validSignal.contextSnapshot, sentiment: 1.5 },
    };
    expect(SignalSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a HOLD verdict without qty/stop/target", () => {
    const hold = { side: "HOLD", confidence: 0.5, reason: "no condition met" };
    expect(StrategyVerdictSchema.safeParse(hold).success).toBe(true);
  });
});

describe("order shapes", () => {
  const order = {
    orderId: "ord_1",
    signalId: "sig_1",
    strategyId: "str_1",
    symbol: "NSE:RELIANCE-EQ",
    side: "BUY",
    qty: 10,
    type: "MARKET",
    status: "PLACED",
    mode: "paper",
    createdAt: ts,
  };

  it("parses a valid order and rejects HOLD as an order side", () => {
    expect(OrderSchema.safeParse(order).success).toBe(true);
    expect(OrderSchema.safeParse({ ...order, side: "HOLD" }).success).toBe(
      false,
    );
  });

  it("declares exactly the terminal statuses of the plan/12 §5 state machine", () => {
    expect([...ORDER_TERMINAL_STATUSES].sort()).toEqual([
      "CANCELLED",
      "FILLED",
      "REJECTED",
    ]);
  });
});

describe("position shapes", () => {
  it("allows qty 0 only alongside CLOSED semantics (shape level: nonnegative)", () => {
    const position = {
      positionId: "pos_1",
      symbol: "NSE:RELIANCE-EQ",
      strategyId: "str_1",
      side: "LONG",
      qty: 0,
      avgEntryPrice: 3000,
      status: "CLOSED",
      realizedPnl: -120.5,
      unrealizedPnl: 0,
      openedAt: ts,
      closedAt: ts + 60_000,
      mode: "paper",
    };
    expect(PositionSchema.safeParse(position).success).toBe(true);
    expect(PositionSchema.safeParse({ ...position, qty: -1 }).success).toBe(
      false,
    );
  });
});

describe("strategy config shapes", () => {
  it("requires at least one symbol", () => {
    const config = {
      strategyId: "str_1",
      ownerId: "usr_1",
      type: "EMA_CROSSOVER",
      name: "EMA 9/21 on Reliance",
      params: { fast: 9, slow: 21 },
      symbols: [] as string[],
      enabled: false,
      status: "active",
      createdAt: ts,
      updatedAt: ts,
    };
    expect(StrategyConfigSchema.safeParse(config).success).toBe(false);
    expect(
      StrategyConfigSchema.safeParse({
        ...config,
        symbols: ["NSE:RELIANCE-EQ"],
      }).success,
    ).toBe(true);
  });

  it("marks a paper subject, and a candidate only by its id (Phase 14 D1)", () => {
    const config = {
      strategyId: "subject_orb",
      ownerId: "operator",
      type: "ORB",
      name: "subject",
      params: {},
      symbols: ["NSE:NIFTY50-INDEX"],
      enabled: true,
      status: "active",
      createdAt: ts,
      updatedAt: ts,
    };
    const parses = (validation: unknown) =>
      StrategyConfigSchema.safeParse({ ...config, validation }).success;
    expect(parses({ role: "subject" })).toBe(true);
    expect(parses({ role: "candidate", candidateId: "SC-0001" })).toBe(true);
    expect(parses({ role: "candidate" })).toBe(false);
    expect(parses({ role: "promoted" })).toBe(false);
  });
});

describe("broker contract shapes (plan/19 §2)", () => {
  it("requires clientOrderId on a broker order request (plan/19 §5)", () => {
    const base = {
      symbol: "NSE:RELIANCE-EQ",
      side: "BUY",
      qty: 10,
      type: "MARKET",
    };
    expect(BrokerOrderRequestSchema.safeParse(base).success).toBe(false);
    expect(
      BrokerOrderRequestSchema.safeParse({ ...base, clientOrderId: "ord_1" })
        .success,
    ).toBe(true);
  });

  it("discriminates execution outcomes and requires a fill on FILLED", () => {
    expect(ExecutionOutcomeSchema.safeParse({ status: "FILLED" }).success).toBe(
      false,
    );
    expect(
      ExecutionOutcomeSchema.safeParse({
        status: "FILLED",
        fill: {
          clientOrderId: "ord_1",
          filledPrice: 2990,
          filledQty: 10,
          slippage: 0,
          charges: 0,
          filledAt: ts,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown execution status rather than guessing", () => {
    expect(
      ExecutionOutcomeSchema.safeParse({
        status: "PARTIALLY_FILLED",
        clientOrderId: "ord_1",
      }).success,
    ).toBe(false);
  });
});

describe("risk decision contract (plan/14 §6)", () => {
  it("requires failedCheck + reason on block", () => {
    expect(RiskDecisionSchema.safeParse({ decision: "blocked" }).success).toBe(
      false,
    );
    expect(
      RiskDecisionSchema.safeParse({
        decision: "blocked",
        failedCheck: "dailyLoss",
        reason: "daily realized loss at limit",
      }).success,
    ).toBe(true);
  });

  it("allows approval with an optional capped qty, never an invented one", () => {
    expect(RiskDecisionSchema.safeParse({ decision: "approved" }).success).toBe(
      true,
    );
    expect(
      RiskDecisionSchema.safeParse({ decision: "approved", cappedQty: 5 })
        .success,
    ).toBe(true);
    expect(
      RiskDecisionSchema.safeParse({ decision: "approved", cappedQty: 0 })
        .success,
    ).toBe(false);
  });
});

describe("hasTrustedVolume (ADR §20.6)", () => {
  const candle = (fields: Record<string, unknown> = {}) =>
    CandleSchema.parse({
      symbol: "NSE:X-EQ",
      interval: "5m",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
      ts: 1_000_000,
      ...fields,
    });

  it("trusts a bar that says nothing — tick-built bars predate the fields", () => {
    expect(hasTrustedVolume(candle())).toBe(true);
    expect(
      hasTrustedVolume(
        candle({ volumeAvailable: true, volumeQuality: "REAL" }),
      ),
    ).toBe(true);
  });

  it("does not trust SUSPECT or UNAVAILABLE volume, or volume marked unavailable", () => {
    expect(hasTrustedVolume(candle({ volumeQuality: "SUSPECT" }))).toBe(false);
    expect(hasTrustedVolume(candle({ volumeQuality: "UNAVAILABLE" }))).toBe(
      false,
    );
    expect(hasTrustedVolume(candle({ volumeAvailable: false }))).toBe(false);
    // Unavailable wins over a REAL label: the two disagreeing is not a reason to believe the number.
    expect(
      hasTrustedVolume(
        candle({ volumeAvailable: false, volumeQuality: "REAL" }),
      ),
    ).toBe(false);
  });
});
