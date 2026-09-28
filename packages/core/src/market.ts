import { z } from "zod";
import {
  CandleIntervalSchema,
  PriceSchema,
  SymbolSchema,
  TimestampSchema,
  type CandleInterval,
} from "./primitives.js";

/**
 * Normalized market-data shapes. Nothing downstream of the Market Data Engine
 * ever sees a broker wire format (plan/17 §2).
 */

/**
 * How far a bar's volume can be trusted (ARCHITECTURE_DECISION §20).
 *
 * Volume is not meaningful for every instrument. An NSE index has no
 * tradeable volume of its own, so a number in that column is either a
 * derived total or a filler — and the two are indistinguishable once
 * stored. Where reliable volume is unavailable, volume-based conclusions
 * are not drawn, which requires the bar to say so rather than the reader
 * to guess from a zero.
 */
export const VolumeQualitySchema = z.enum(["REAL", "SUSPECT", "UNAVAILABLE"]);
export type VolumeQuality = z.infer<typeof VolumeQualitySchema>;
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

/** Interval durations in ms. */
const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "60m": 3_600_000,
};

/**
 * Bucket width for an interval.
 *
 * This is the aggregator bucketing unit (`floor(ts / intervalMs) *
 * intervalMs`) and therefore also the alignment historical bars are validated
 * against. The two must use the same number, or a backfilled bar can land in a
 * bucket live aggregation would never produce.
 */
export function intervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}

export const CandleSchema = z.object({
  symbol: SymbolSchema,
  interval: CandleIntervalSchema,
  open: PriceSchema,
  high: PriceSchema,
  low: PriceSchema,
  close: PriceSchema,
  /**
   * Traded quantity in the bucket.
   *
   * Still required and still non-negative: a bar always has a number here
   * so every existing reader keeps working. What changed is that the
   * number is no longer self-describing — read `volumeAvailable` before
   * drawing a conclusion from it. A source that supplied no volume stores
   * 0 with `volumeAvailable: false`, which is not the same fact as a real
   * zero and must never be treated as one.
   */
  volume: z.number().nonnegative(),
  /**
   * False when the source did not supply usable volume for this bar
   * (ARCHITECTURE_DECISION §20).
   *
   * Optional, and absence means available: every bar written before this
   * field existed came from tick aggregation, where the volume is real.
   * Making it required would throw on the first read after deploy, the
   * same trap `source` avoided with its default.
   */
  volumeAvailable: z.boolean().optional(),
  /** Where the volume came from, when that differs from the bar's own source. */
  volumeSource: z.string().min(1).optional(),
  /** How far the number can be trusted. Absent means REAL. */
  volumeQuality: VolumeQualitySchema.optional(),
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
