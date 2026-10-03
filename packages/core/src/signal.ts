import { z } from "zod";
import {
  DataProvenanceSchema,
  EntryMarketContextSchema,
  ExitReasonSchema,
} from "./trade.js";
import {
  ConfidenceSchema,
  EntityIdSchema,
  PriceSchema,
  QuantitySchema,
  SymbolSchema,
  TimestampSchema,
} from "./primitives.js";
import { SessionPhaseSchema } from "./market.js";

/** BUY / SELL / HOLD — a strategy's verdict (plan/15 §2). */
export const SignalSideSchema = z.enum(["BUY", "SELL", "HOLD"]);
export type SignalSide = z.infer<typeof SignalSideSchema>;

/**
 * The exact values a decision saw, frozen forever with the signal
 * (plan/07 `signals.contextSnapshot`, plan/18 §7 audit note).
 * Live values are ephemeral; decision-time values are permanent.
 */
export const ContextSnapshotSchema = z.object({
  price: PriceSchema,
  indicators: z.record(z.string(), z.number()),
  session: SessionPhaseSchema,
  /** Clamped AI sentiment the context carried; 0 = neutral/absent (plan/20 §4). */
  sentiment: z.number().min(-1).max(1),
});
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

/** What `analyze()` returns — pure decision output (plan/15 §2). */
export const StrategyVerdictSchema = z.object({
  side: SignalSideSchema,
  confidence: ConfidenceSchema,
  qtyProposal: QuantitySchema.optional(),
  stopLoss: PriceSchema.optional(),
  target: PriceSchema.optional(),
  /**
   * Stop and target as fractions of the ENTRY price, for when the strategy
   * cannot name an absolute one.
   *
   * An index-options strategy reads the index and buys a contract: a stop of
   * "index 24,800" says nothing about what a 150-rupee premium is worth,
   * and delta makes the mapping non-linear anyway. Option stops are therefore
   * conventionally a percentage of premium paid — and the premium is not known
   * until the contract is resolved. The runner converts these to absolute
   * prices once it has one (plan/15 §4).
   */
  stopLossPct: z.number().gt(0).lt(1).optional(),
  targetPct: z.number().gt(0).optional(),
  /** Mandatory human-readable justification (plan/15 §2). */
  reason: z.string().min(1),
});
export type StrategyVerdict = z.infer<typeof StrategyVerdictSchema>;

export const SignalOutcomeSchema = z.enum(["accepted", "rejected"]);
export type SignalOutcome = z.infer<typeof SignalOutcomeSchema>;

/** The persisted decision record (plan/07 `signals`). */
export const SignalSchema = z.object({
  signalId: EntityIdSchema,
  strategyId: EntityIdSchema,
  /**
   * The strategy's version at the moment of the decision (design §5.4 Q4).
   *
   * Optional, and absence means a record written before versions existed —
   * the same reason `source` was defaulted rather than required. A required
   * field would throw on the first read of anything already in Mongo.
   *
   * Copied forward rather than referenced. Each of Signal, Order and Trade
   * is written at a different moment by a different component, and a trade
   * whose version had to be looked up through its order would lose it the
   * moment orders are pruned.
   */
  strategyVersion: z.string().min(1).optional(),
  /**
   * Why this signal closes a position, when it does (ADR §9.2, D6).
   *
   * Typed rather than parsed back out of `reason`. The Exit Engine
   * already writes `"exit: stop"` there for humans; deriving the enum from
   * that string would make a log line load-bearing, and the first person
   * to reword it would silently change what every completed trade claims
   * about why it ended.
   *
   * Absent on an entry signal, and absent is the honest value: a trade
   * closed by something that never said why must not be given a reason it
   * did not have.
   */
  exitReason: ExitReasonSchema.optional(),
  symbol: SymbolSchema,
  /**
   * What the strategy ANALYSED, when that differs from what it trades.
   *
   * `symbol` is always the traded contract — risk, orders and positions all
   * key on it and must never see anything else. For a derivative strategy the
   * decision was made on the underlying, and losing that would make the signal
   * unauditable: you could not tell which index move produced the trade.
   */
  underlyingSymbol: SymbolSchema.optional(),
  side: SignalSideSchema,
  confidence: ConfidenceSchema,
  qtyProposal: QuantitySchema.optional(),
  stopLoss: PriceSchema.optional(),
  target: PriceSchema.optional(),
  reason: z.string().min(1),
  contextSnapshot: ContextSnapshotSchema,
  /**
   * The bar this decision was made on (design §2, drift 1).
   *
   * Stamped by the Strategy Runner, the only component holding the bar at
   * decision time, and copied forward — Order, `ORDER_FILLED`, Trade — the
   * same road as `strategyVersion`. Optional: every signal already stored
   * predates it, and an Exit Engine decision is not an entry.
   */
  dataProvenance: DataProvenanceSchema.optional(),
  /** Whether that bar's volume could be trusted (design §2, drift 3). */
  marketContext: EntryMarketContextSchema.optional(),
  outcome: SignalOutcomeSchema.optional(),
  rejectReason: z.string().optional(),
  ts: TimestampSchema,
});
export type Signal = z.infer<typeof SignalSchema>;
