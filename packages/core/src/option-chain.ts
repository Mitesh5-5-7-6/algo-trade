import { z } from "zod";
import { TimestampSchema } from "./primitives.js";

export const OptionChainRowSchema = z.object({
  strike: z.number().positive(),
  callOI: z.number().nonnegative(),
  putOI: z.number().nonnegative(),
  callChangeOI: z.number(),
  putChangeOI: z.number(),
  callIV: z.number().nonnegative().optional(),
  putIV: z.number().nonnegative().optional(),
  callLtp: z.number().positive().optional(),
  putLtp: z.number().positive().optional(),
  callVolume: z.number().nonnegative().optional(),
  putVolume: z.number().nonnegative().optional(),
  callBid: z.number().nonnegative().optional(),
  callAsk: z.number().nonnegative().optional(),
  putBid: z.number().nonnegative().optional(),
  putAsk: z.number().nonnegative().optional(),
});
export type OptionChainRow = z.infer<typeof OptionChainRowSchema>;

/** Normalized chain data for one underlying and expiry at one instant. */
export const OptionChainSnapshotSchema = z.object({
  underlying: z.string().min(1),
  expiry: TimestampSchema,
  asOf: TimestampSchema,
  spot: z.number().positive(),
  rows: z.array(OptionChainRowSchema).min(1),
});
export type OptionChainSnapshot = z.infer<typeof OptionChainSnapshotSchema>;
