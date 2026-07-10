import type {
  Candle,
  MarketContext,
  Position,
  SessionContext,
} from "@neelkanth/core";

export interface ContextInput {
  symbol: string;
  interval: Candle["interval"];
  candle: Candle;
  candles: Candle[];
  indicators: Readonly<Record<string, number>>;
  session: SessionContext;
  position: Position | null;
  sentiment: number;
}

/**
 * The Market Context Builder (plan/15 §3): assemble one immutable snapshot from
 * already-validated parts. A built snapshot (rather than letting strategies
 * read Redis) buys three things — consistency (every value from the same
 * instant), isolation (strategies get no infrastructure access), and
 * testability (a context is a plain object). Kept a plain constructor on the
 * hot path; the shape is guaranteed by its typed inputs (MarketContextSchema
 * validates it in tests).
 */
export function buildContext(input: ContextInput): MarketContext {
  return {
    symbol: input.symbol,
    interval: input.interval,
    candle: input.candle,
    candles: input.candles,
    indicators: { ...input.indicators },
    session: input.session,
    position: input.position,
    sentiment: input.sentiment,
  };
}
