import { z } from "zod";
import { EntityIdSchema, SymbolSchema, TimestampSchema } from "./primitives.js";

/**
 * What to trade for one approved entry, in the operator's terms: the
 * contract, its buy price, its stop and its target — in the contract's own
 * price, and in points from the entry.
 *
 * Shown on the dashboard and sent to Telegram when a strategy's entry passes
 * the Risk Engine (decided by the operator 2026-11-18). It is a READ of a
 * decision already taken, never an input to one: nothing in the order path
 * reads a card.
 *
 * `basis` says where the numbers come from, because they are not equally
 * firm:
 *
 * - `OPTION_STRATEGY` — an option strategy's own signal: the contract it
 *   resolved, the premium it was priced at, and the stop and target it set
 *   on that premium. Exactly what the paper order carries.
 * - `INDEX_SUGGESTED` — a strategy that decides and trades on the INDEX (ORB,
 *   EMA crossover). The card suggests the at-the-money call (a buy signal) or
 *   put (a sell signal) at its live premium, and turns the index stop and
 *   target into premium levels at an assumed delta. Those premium levels are
 *   ESTIMATES (`estimated: true`): a real option also moves with time and
 *   volatility. The index levels the strategy actually set are kept beside
 *   them.
 * - `DIRECT` — a strategy on a tradable symbol (a stock): the symbol itself.
 */
/**
 * The Time Machine's odds for a card's plan (operator decision 2026-11-18),
 * asked of the research service after the order is placed — never in its way.
 * On the UNDERLYING's bars, in index points: an option's premium also moves
 * with time and volatility.
 */
export const CardOddsSchema = z.object({
  /** OK; UNAVAILABLE when asked and not answered; NOT_RUN when not askable. */
  status: z.enum(["OK", "UNAVAILABLE", "NOT_RUN"]),
  /** Why it is unavailable or not run, or what the plan's levels rest on. */
  reason: z.string().min(1).nullable(),
  /** The plan asked about, on the underlying. */
  plan: z
    .object({
      side: z.enum(["LONG", "SHORT"]),
      entry: z.number().positive(),
      stop: z.number().positive(),
      target: z.number().positive(),
      /** True when the levels were worked back from premium at a delta. */
      estimated: z.boolean(),
    })
    .nullable(),
  /** Replays of the rest of the day from past sessions. */
  replays: z.number().int().nonnegative().nullable(),
  sessions: z.number().int().nonnegative().nullable(),
  /** Shares of the replays, 0..1. */
  targetFirst: z.number().min(0).max(1).nullable(),
  stopFirst: z.number().min(0).max(1).nullable(),
  neither: z.number().min(0).max(1).nullable(),
  /** The target's share needed to break even, 1 / (1 + R). */
  breakEven: z.number().min(0).max(1).nullable(),
  /** The resampled verdict against break-even, e.g. NEAR_BREAK_EVEN. */
  verdict: z.string().min(1).nullable(),
  /** The strategy's own rule over real history, for a replayable rule. */
  history: z
    .object({
      rule: z.string().min(1),
      fired: z.number().int().nonnegative(),
      averageR: z.number().nullable(),
      verdict: z.string().min(1),
    })
    .nullable(),
  fingerprint: z.string().nullable(),
});
export type CardOdds = z.infer<typeof CardOddsSchema>;

export const TradeCardSchema = z.object({
  /** The signal's id: one card per approved entry. */
  signalId: EntityIdSchema,
  strategyId: EntityIdSchema,
  strategyName: z.string().min(1),
  ts: TimestampSchema,
  basis: z.enum(["OPTION_STRATEGY", "INDEX_SUGGESTED", "DIRECT"]),
  /** What the decision was made on: the index, or the stock. */
  underlying: SymbolSchema,
  direction: z.enum(["BULLISH", "BEARISH"]),
  /** What to trade; null when no contract could be found for the suggestion. */
  contract: SymbolSchema.nullable(),
  optionType: z.enum(["CE", "PE"]).nullable(),
  strike: z.number().positive().nullable(),
  expiry: TimestampSchema.nullable(),
  lotSize: z.number().int().positive().nullable(),
  /** BUY for every option card: an option is bought, never written. */
  action: z.enum(["BUY", "SELL"]),
  /** In the contract's own price (premium for an option); null when unknown. */
  entry: z.number().positive().nullable(),
  stopLoss: z.number().positive().nullable(),
  target: z.number().positive().nullable(),
  /** Distances from the entry, in the same units. */
  stopPoints: z.number().nonnegative().nullable(),
  targetPoints: z.number().nonnegative().nullable(),
  /** targetPoints / stopPoints. */
  rewardRisk: z.number().nonnegative().nullable(),
  /** True when the premium stop and target are estimated from index levels. */
  estimated: z.boolean(),
  /** The delta the estimate assumed, when it is one. */
  assumedDelta: z.number().positive().max(1).nullable(),
  /** The levels the strategy set on the index, for an index strategy. */
  index: z
    .object({
      entry: z.number().positive(),
      stopLoss: z.number().positive().nullable(),
      target: z.number().positive().nullable(),
    })
    .nullable(),
  /** Why the strategy entered, in its words. */
  reason: z.string().min(1),
  /** What the card could not say, when something was missing. */
  note: z.string().min(1).nullable(),
  /** The Time Machine's odds for the plan; absent until asked. */
  odds: CardOddsSchema.optional(),
});
export type TradeCard = z.infer<typeof TradeCardSchema>;
