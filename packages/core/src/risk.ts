import { z } from "zod";
import {
  EntityIdSchema,
  QuantitySchema,
  SymbolSchema,
  TimestampSchema,
} from "./primitives.js";

/** The four checks, in their deliberate order (plan/14 §4). */
export const RiskCheckNameSchema = z.enum([
  "session",
  "duplicate",
  "dailyLoss",
  "positionSize",
]);
export type RiskCheckName = z.infer<typeof RiskCheckNameSchema>;

/**
 * The decision contract of `validate(signal)` (plan/14 §6). Binary outcome,
 * always with a reason on block; may cap (never invent) the proposed qty.
 */
export const RiskDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    cappedQty: QuantitySchema.optional(),
  }),
  z.object({
    decision: z.literal("blocked"),
    failedCheck: RiskCheckNameSchema,
    reason: z.string().min(1),
  }),
]);
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;

/**
 * Fully-resolved risk limits the engine evaluates against — the operator's
 * global limits (`settings.globalRiskLimits`) after merging a strategy's
 * override (`strategies.riskRules`), which may only make them STRICTER
 * (plan/14 §4). All fields are upper bounds.
 */
export const RiskLimitsSchema = z.object({
  /** Max realized loss for the day before entries auto-halt (plan/14 §4.3). */
  maxDailyLoss: z.number().positive(),
  /** Max quantity in a single position. */
  maxPositionSize: z.number().int().positive(),
  /** Max capital committed to one trade. */
  maxCapitalPerTrade: z.number().positive(),
  /** Max number of concurrently open positions. */
  maxOpenPositions: z.number().int().positive(),
  /** Max portfolio exposure as a fraction of allocated capital [0,1]. */
  maxExposure: z.number().min(0).max(1),
});
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

/** One check's outcome, recorded for the audit trail (plan/14 §7). */
export const RiskCheckResultSchema = z.object({
  check: RiskCheckNameSchema,
  passed: z.boolean(),
  /** What the check saw (values at decision time) — the forensic record. */
  detail: z.string().optional(),
});
export type RiskCheckResult = z.infer<typeof RiskCheckResultSchema>;

/**
 * A persisted risk decision (plan/07 `risk_logs`, plan/14 §7): every
 * `validate()` call, approvals and blocks alike, with each check and the
 * values it saw — so both "why was this allowed?" and "why was this blocked?"
 * are reconstructable.
 */
export const RiskLogSchema = z.object({
  signalId: EntityIdSchema,
  strategyId: EntityIdSchema,
  symbol: SymbolSchema,
  decision: z.enum(["approved", "blocked"]),
  failedCheck: RiskCheckNameSchema.optional(),
  reason: z.string().optional(),
  cappedQty: QuantitySchema.optional(),
  checks: z.array(RiskCheckResultSchema),
  ts: TimestampSchema,
});
export type RiskLog = z.infer<typeof RiskLogSchema>;
