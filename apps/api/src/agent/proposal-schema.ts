import { z } from "zod/v4";

const REGIMES = ["ALL", "BULLISH", "BEARISH", "NEUTRAL"] as const;

/**
 * A proposed hypothesis (Phase 12 D1): a claim about an existing strategy on
 * a cell — as configured, or with a parameter variant — and the evidence it
 * rests on. The model chooses none of the windows, alpha, minSample or run.
 */
export const ProposalSchema = z.strictObject({
  statement: z
    .string()
    .describe(
      "the claim in one sentence, e.g. 'ORB loses money after ORB_BREAKOUT in a BEARISH regime'",
    ),
  cell: z.strictObject({
    patternId: z
      .string()
      .describe(
        "a detector id, e.g. ORB_BREAKOUT — or ALL for the strategy's baseline",
      ),
    strategyType: z.string().describe("a replayable strategy, e.g. ORB"),
    symbol: z.string().describe("an instrument researched, or ALL"),
    regime: z.enum(REGIMES),
  }),
  metric: z.enum(["winRate", "expectancy", "expectancyPerUnit"]),
  direction: z.enum(["greater", "less"]),
  threshold: z
    .number()
    .describe(
      "the value the metric is claimed to exceed or fall below; a win rate is 0 to 1",
    ),
  strategyParams: z
    .array(
      z.strictObject({
        name: z.string(),
        value: z.union([z.number(), z.string(), z.boolean()]),
      }),
    )
    .describe(
      "a parameter variant of the strategy; empty for the strategy as configured",
    ),
  rationale: z
    .array(
      z.strictObject({
        statement: z.string(),
        cites: z.array(z.string()),
      }),
    )
    .describe(
      "the evidence the claim rests on — claims citing call ids, checked like any claim",
    ),
});
export type Proposal = z.infer<typeof ProposalSchema>;
