import { z } from "zod";
import {
  EntityIdSchema,
  QuantitySchema,
  SymbolSchema,
  TimestampSchema,
} from "./primitives.js";

/** The checks, in their deliberate order (plan/14 §4). */
export const RiskCheckNameSchema = z.enum([
  "session",
  "duplicate",
  "marketBias",
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
    /**
     * The quantity to trade, as the engine sized it (plan/14 §4.4).
     *
     * Named for what it originally was — a cap on the strategy's proposal —
     * but since sizing moved into the engine it carries the computed size on
     * every approval, whether or not a limit was binding. The Order Manager
     * falls back to `signal.qtyProposal` when it is absent, so "absent" must
     * mean "the engine did not size this", never "the proposal was fine".
     */
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
  /**
   * Fraction of allocated capital to put at risk on one trade — the input to
   * position sizing (plan/14 §4.4).
   *
   * This is the standard formulation: size follows from what you are willing
   * to lose, `riskPerTrade × capital`, divided by the distance to the stop.
   * The alternative the system started with — a fixed `quantity` in strategy
   * params — is not sizing at all: it risks a different amount on every
   * instrument, and a different amount again each time the stop moves.
   *
   * Defaulted, not required, so settings rows written before it existed still
   * parse. 1% is the conventional starting point.
   */
  riskPerTrade: z.number().min(0).max(1).default(0.01),

  // --- F&O limits (plan/14 §4.4, derivatives) ---
  //
  // Derivatives are sized in LOTS, not shares, so they get their own budget
  // knobs rather than borrowing the equity ones. Every field is OPTIONAL and
  // falls back to its equity counterpart (`resolveFnoLimits`): an operator who
  // has not configured F&O separately gets today's limits, never looser ones.
  //
  // In particular `fnoRiskPerTrade` does NOT default to some larger number.
  // A single lot of a ₹65-multiplier contract can easily risk more than 1% of
  // a small account, and the honest answer to that is "this trade does not
  // fit", not a budget quietly widened until it does.

  /** Fraction of allocated capital risked on one F&O trade. Falls back to `riskPerTrade`. */
  fnoRiskPerTrade: z.number().min(0).max(1).optional(),
  /** Hard ceiling on lots in a single F&O trade. Unbounded when absent — the risk, capital and exposure capacities still bind. */
  fnoMaxLotsPerTrade: z.number().int().positive().optional(),
  /** Max capital committed to one F&O trade. Falls back to `maxCapitalPerTrade`. */
  fnoMaxCapitalPerTrade: z.number().positive().optional(),
  /** Max portfolio exposure for F&O as a fraction of allocated capital. Falls back to `maxExposure`. */
  fnoMaxExposure: z.number().min(0).max(1).optional(),
  /** Max concurrently open F&O positions. Falls back to `maxOpenPositions`. */
  fnoMaxOpenPositions: z.number().int().positive().optional(),
});
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

/**
 * The F&O sizing arithmetic, recorded whole (plan/14 §7).
 *
 * Stored as structured fields rather than folded into a sentence because the
 * question a blocked F&O trade raises is always "which capacity bound, and by
 * how much?" — and "one lot of 60 does not fit in 44" cannot answer it. Every
 * capacity is in LOTS, so they are directly comparable; `allowedLots` is their
 * minimum and `finalQuantity` is `allowedLots × lotSize`.
 */
export const FnoSizingLogSchema = z.object({
  symbol: SymbolSchema,
  instrumentType: z.enum(["OPTION", "FUTURE"]),
  /**
   * What `capitalPerLot` measures. `PREMIUM` is an option buyer's exact cash
   * outlay; `NOTIONAL` is a future's contract value, which is NOT the margin
   * posted — it stands in for margin, conservatively, until broker margin data
   * exists. Recorded so a stored decision can never be misread as margin-based.
   */
  capitalBasis: z.enum(["PREMIUM", "NOTIONAL"]),
  lotSize: z.number().int().positive(),
  entryPrice: z.number().positive(),
  stopPrice: z.number().positive(),
  stopDistance: z.number().nonnegative(),
  riskPerLot: z.number().nonnegative(),
  capitalPerLot: z.number().nonnegative(),
  riskBudget: z.number().nonnegative(),
  riskCapacityLots: z.number().int().nonnegative(),
  capitalCapacityLots: z.number().int().nonnegative(),
  exposureCapacityLots: z.number().int().nonnegative(),
  /** The configured per-trade lot ceiling, or null when unbounded. */
  maxLotsPerTrade: z.number().int().positive().nullable(),
  /** Lots permitted by the open-position cap: 0 when at the cap, else unbounded (null). */
  openPositionCapacityLots: z.number().int().nonnegative().nullable(),
  allowedLots: z.number().int().nonnegative(),
  finalQuantity: z.number().int().nonnegative(),
  /** Null on approval; otherwise which capacity bound to zero, and why. */
  blockedReason: z.string().nullable(),
});
export type FnoSizingLog = z.infer<typeof FnoSizingLogSchema>;

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
  /** Present on every F&O decision that reached sizing — the lot arithmetic in full. */
  fnoSizing: FnoSizingLogSchema.optional(),
  ts: TimestampSchema,
});
export type RiskLog = z.infer<typeof RiskLogSchema>;
