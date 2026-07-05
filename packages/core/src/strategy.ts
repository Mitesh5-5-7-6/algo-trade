import { z } from "zod";
import { EntityIdSchema, SymbolSchema, TimestampSchema } from "./primitives.js";

/**
 * Per-strategy risk overrides (plan/07 `strategies.riskRules`).
 * The Risk Engine enforces that overrides may only be STRICTER than the
 * global limits (plan/14 §4) — that comparison is runtime logic, not shape.
 */
export const RiskRulesSchema = z.object({
  maxPositionSize: z.number().int().positive().optional(),
  maxCapitalPerTrade: z.number().positive().optional(),
  maxOpenPositions: z.number().int().positive().optional(),
  maxExposure: z.number().min(0).max(1).optional(),
  maxDailyLoss: z.number().positive().optional(),
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
  enabled: z.boolean(),
  status: StrategyStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
