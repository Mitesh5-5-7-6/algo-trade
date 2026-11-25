import { z } from "zod";
import type { Position } from "./position.js";

/**
 * The three-part target (PLAN.md 14.17, operator decisions 2026-11-25).
 *
 * ONE entry, never added to. The distance from entry to the strategy's own
 * target is split into equal thirds: T1, T2, T3 (= the target). Nothing is
 * sold at T1 or T2 unless the gate says so:
 *
 *  - price reaches T1 → look up the chance of reaching T2 before falling back
 *    to the entry. Below the threshold: sell ALL now. Otherwise: hold all and
 *    move the stop to the entry price.
 *  - price reaches T2 → the same for T3, the stop still at the entry (two
 *    steps back, one step on).
 *  - T3 is the ordinary target.
 *
 * No chance known for a case → hold: the gate only ever exits EARLY.
 */

/** Exit everything at a checkpoint when the chance of the next is below this. */
export const CHECKPOINT_MIN_CHANCE = 0.4;

/** A table row is evidence only with at least this many past cases. */
export const CHECKPOINT_MIN_SAMPLES = 30;

/** How a premium move maps to the index, for an option position. */
export const CHECKPOINT_ASSUMED_DELTA = 0.5;

export interface CheckpointLevels {
  t1: number;
  t2: number;
  t3: number;
}

/** T1/T2/T3 for a position, or null when it has no target on the right side. */
export function checkpointLevels(
  position: Pick<Position, "side" | "avgEntryPrice" | "target">,
): CheckpointLevels | null {
  const { target, avgEntryPrice: entry } = position;
  if (target === undefined) return null;
  const distance = target - entry;
  if (position.side === "LONG" ? distance <= 0 : distance >= 0) return null;
  return {
    t1: entry + distance / 3,
    t2: entry + (2 * distance) / 3,
    t3: target,
  };
}

export const CheckpointOddsRowSchema = z.object({
  /** The index the move is measured on, e.g. "NSE:NIFTY50-INDEX". */
  underlying: z.string().min(1),
  direction: z.enum(["UP", "DOWN"]),
  /** Minutes since the session open at the start of the hour bucket. */
  fromMinute: z.number().int().nonnegative(),
  /** The move on, as a fraction of the index (0.002 = 0.2%). */
  movePct: z.number().positive(),
  /** How far back the stop sits, in units of the move on (1 or 2). */
  back: z.number().int().positive(),
  samples: z.number().int().nonnegative(),
  /** Share of samples where the move on came first. */
  chance: z.number().min(0).max(1),
});
export type CheckpointOddsRow = z.infer<typeof CheckpointOddsRowSchema>;

export const CheckpointOddsTableSchema = z.object({
  builtAt: z.number(),
  sessions: z.number().int().nonnegative(),
  rows: z.array(CheckpointOddsRowSchema),
});
export type CheckpointOddsTable = z.infer<typeof CheckpointOddsTableSchema>;

/** The move sizes the table is built for, as fractions of the index. */
export const CHECKPOINT_MOVE_GRID = [
  0.001, 0.0015, 0.002, 0.003, 0.004, 0.005, 0.007, 0.01,
] as const;

/** Index symbol and direction a position's move is judged on, or null. */
export function checkpointUnderlying(
  position: Pick<Position, "symbol" | "side">,
): { underlying: string; direction: "UP" | "DOWN"; option: boolean } | null {
  const s = position.symbol;
  const long = position.side === "LONG";
  if (s === "NSE:NIFTY50-INDEX" || s === "NSE:NIFTYBANK-INDEX")
    return { underlying: s, direction: long ? "UP" : "DOWN", option: false };
  const index = s.startsWith("NSE:BANKNIFTY")
    ? "NSE:NIFTYBANK-INDEX"
    : s.startsWith("NSE:NIFTY") && !s.startsWith("NSE:NIFTYIT")
      ? "NSE:NIFTY50-INDEX"
      : null;
  if (index === null) return null;
  // A bought call rises with the index, a bought put with its fall. Only a
  // bought option is a checkpoint case: a written one never should exist.
  if (s.endsWith("CE") && long)
    return { underlying: index, direction: "UP", option: true };
  if (s.endsWith("PE") && long)
    return { underlying: index, direction: "DOWN", option: true };
  return null;
}

/**
 * The chance, from the table, of the next part. Null when the table has no
 * case with enough evidence — the caller then holds.
 */
export function checkpointChance(
  table: CheckpointOddsTable,
  query: {
    underlying: string;
    direction: "UP" | "DOWN";
    minutesSinceOpen: number;
    movePct: number;
    back: number;
  },
): number | null {
  const fromMinute = Math.floor(Math.max(0, query.minutesSinceOpen) / 60) * 60;
  const candidates = table.rows.filter(
    (r) =>
      r.underlying === query.underlying &&
      r.direction === query.direction &&
      r.fromMinute === fromMinute &&
      r.back === query.back &&
      r.samples >= CHECKPOINT_MIN_SAMPLES,
  );
  if (candidates.length === 0) return null;
  // The nearest move size on a log scale: 0.2% is as far from 0.1% as 0.4%.
  let best = candidates[0];
  if (best === undefined) return null;
  for (const r of candidates)
    if (
      Math.abs(Math.log(r.movePct / query.movePct)) <
      Math.abs(Math.log(best.movePct / query.movePct))
    )
      best = r;
  // Too far from anything measured is not evidence for this move.
  if (Math.abs(Math.log(best.movePct / query.movePct)) > Math.log(2))
    return null;
  return best.chance;
}
