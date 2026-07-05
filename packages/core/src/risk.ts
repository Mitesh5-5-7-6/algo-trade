import { z } from "zod";
import { QuantitySchema } from "./primitives.js";

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
