import { z } from "zod";
import { EntityIdSchema, SymbolSchema, TimestampSchema } from "./primitives.js";

/**
 * Per-strategy risk overrides (plan/07 `strategies.riskRules`).
 * The Risk Engine enforces that overrides may only be STRICTER than the
 * global limits (plan/14 §4) — that comparison is runtime logic, not shape.
 */
/**
 * Per-strategy exit behaviour (Phase 3).
 *
 * Separate from `RiskRules`, which is about how much to risk. These are
 * about when to get out, and conflating them would make a strategy that
 * wants a time exit look like one that wants a different position size.
 * Part of the strategy's derived version: an exit rule changes what it
 * decides.
 */
export const ExitRulesSchema = z.object({
  /**
   * Close after this many minutes in the trade (D2).
   *
   * Measured from the ENTRY FILL to the close of the bar being judged —
   * never from the signal: `PENDING` is not `FILLED`, and a 30-minute rule
   * measured from a signal that sat unfilled for eight of them is not the
   * rule anybody wrote.
   */
  maxHoldMinutes: z.number().int().positive().optional(),
});
export type ExitRules = z.infer<typeof ExitRulesSchema>;

export const RiskRulesSchema = z.object({
  maxPositionSize: z.number().int().positive().optional(),
  maxCapitalPerTrade: z.number().positive().optional(),
  maxOpenPositions: z.number().int().positive().optional(),
  maxExposure: z.number().min(0).max(1).optional(),
  maxDailyLoss: z.number().positive().optional(),
  /** Risk a smaller slice of capital on this strategy than the global default. */
  riskPerTrade: z.number().min(0).max(1).optional(),
  // F&O overrides, stricter-only like every other field here.
  fnoRiskPerTrade: z.number().min(0).max(1).optional(),
  fnoMaxLotsPerTrade: z.number().int().positive().optional(),
  fnoMaxCapitalPerTrade: z.number().positive().optional(),
  fnoMaxExposure: z.number().min(0).max(1).optional(),
  fnoMaxOpenPositions: z.number().int().positive().optional(),
});
export type RiskRules = z.infer<typeof RiskRulesSchema>;

export const StrategyStatusSchema = z.enum(["active", "errored", "deleted"]);
export type StrategyStatus = z.infer<typeof StrategyStatusSchema>;

/**
 * The operator's strategy configuration (plan/07 `strategies`).
 * `params` is validated against the concrete strategy type's own Zod schema
 * at enable time (plan/15 §4); here it is an opaque, shape-checked record.
 */
export const StrategyConfigSchema = z.object({
  strategyId: EntityIdSchema,
  ownerId: EntityIdSchema,
  /** Registry key mapping config to code (plan/15 §4), e.g. "EMA_CROSSOVER". */
  type: z.string().min(1),
  name: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  symbols: z.array(SymbolSchema).min(1),
  riskRules: RiskRulesSchema.optional(),
  exitRules: ExitRulesSchema.optional(),
  enabled: z.boolean(),
  status: StrategyStatusSchema,
  /**
   * Bumped whenever a change would alter what this strategy decides.
   *
   * A later edit must never rewrite what past trades were made by, so the
   * value is stamped onto each decision rather than joined at read time.
   * Optional today: every strategy already stored predates it.
   *
   * Deliberately NOT derived from `updatedAt`. A timestamp changes when a
   * name is corrected, which is not a different strategy — and research
   * comparing versions would then see change where there was none. An
   * exact-code identity (`strategyRevision`, a commit hash) is a later
   * addition, not a replacement.
   */
  strategyVersion: z.string().min(1).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
