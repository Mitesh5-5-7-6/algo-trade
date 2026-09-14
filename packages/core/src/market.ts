import { z } from "zod";
import {
  CandleIntervalSchema,
  PriceSchema,
  SymbolSchema,
  TimestampSchema,
} from "./primitives.js";

/**
 * Normalized market-data shapes. Nothing downstream of the Market Data Engine
 * ever sees a broker wire format (plan/17 §2).
 */

export const TickSchema = z.object({
  symbol: SymbolSchema,
  ltp: PriceSchema,
  volume: z.number().nonnegative(),
  bid: PriceSchema.optional(),
  ask: PriceSchema.optional(),
  ts: TimestampSchema,
});
export type Tick = z.infer<typeof TickSchema>;

/**
 * Where a bar came from (docs/design/PHASE_1_HISTORICAL_DATA.md D2).
 *
 * The research system must never silently mix data sources: a bar the broker
 * consolidated and a bar we aggregated from a feed that can drop ticks are not
 * the same evidence, and a backfill that overwrote the second with the first
 * has to be able to say so afterwards.
 *
 * Ordering here is not the precedence order — see `CANDLE_SOURCE_RANK`.
 */
export const CandleSourceSchema = z.enum([
  /** Aggregated in-process from the live tick feed. */
  "LIVE_TICK",
  /** Fetched from the broker's historical endpoint. */
  "BROKER_HISTORICAL",
  /** Produced by a replay run. Never written to the trading `candles`. */
  "REPLAY",
  /** Vetted third-party data, deliberately loaded. */
  "IMPORTED_DATA",
]);
export type CandleSource = z.infer<typeof CandleSourceSchema>;

/**
 * Precedence when two producers write the same (symbol, interval, ts). Higher
 * wins; a write may never demote the stored bar (design D3).
 *
 * The invariant this protects: **one (symbol, interval, ts) is one canonical
 * candle**, whatever produced it. Provenance records where a bar came from; it
 * never creates a second bar.
 */
export const CANDLE_SOURCE_RANK: Readonly<Record<CandleSource, number>> = {
  BROKER_HISTORICAL: 3, // the exchange's own consolidated record
  IMPORTED_DATA: 2, // vetted third-party, deliberately loaded
  LIVE_TICK: 1, // our aggregation of a feed that can drop ticks
  REPLAY: 0, // never reaches the trading collection at all
};

export const CandleSchema = z.object({
  symbol: SymbolSchema,
  interval: CandleIntervalSchema,
  open: PriceSchema,
  high: PriceSchema,
  low: PriceSchema,
  close: PriceSchema,
  volume: z.number().nonnegative(),
  /** Bucket start time (plan/17 §5). */
  ts: TimestampSchema,
  /**
   * Provenance. Defaulted rather than required so that every bar already in
   * Mongo — all of which predate historical ingestion and so came from tick
   * aggregation — still parses. `CandlesRepository.loadRecent` parses every
   * document it reads, and indicator warm-up reads on every boot: a required
   * field here would have thrown on the first read after deploy.
   */
  source: CandleSourceSchema.default("LIVE_TICK"),
  /** When this bar was written, for a backfill run to be auditable after it. */
  ingestedAt: TimestampSchema.optional(),
  /**
   * Which ingestion produced it. Carried so the data-revision policy can answer
   * "which bars came from the run I now distrust?" without re-deriving it
   * (RND_RESEARCH_SPECIFICATION §5.7). Written by the backfill job; live
   * aggregation leaves it unset.
   */
  ingestionVersion: z.number().int().positive().optional(),
});
export type Candle = z.infer<typeof CandleSchema>;

/** Session phase written to hot:session by the session manager (plan/17 §6). */
export const SessionPhaseSchema = z.enum(["pre-open", "open", "closed"]);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;
