import { z } from "zod";
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
  symbol: SymbolSchema,
  side: SignalSideSchema,
  confidence: ConfidenceSchema,
  qtyProposal: QuantitySchema.optional(),
  stopLoss: PriceSchema.optional(),
  target: PriceSchema.optional(),
  reason: z.string().min(1),
  contextSnapshot: ContextSnapshotSchema,
  outcome: SignalOutcomeSchema.optional(),
  rejectReason: z.string().optional(),
  ts: TimestampSchema,
});
export type Signal = z.infer<typeof SignalSchema>;
