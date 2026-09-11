import {
  UNKNOWN_MARKET_VIEW,
  type Candle,
  type IndexRead,
  type MarketBias,
  type MarketView,
} from "@neelkanth/core";

export interface MarketBiasConfig {
  /**
   * Bars used for the index trend EMA. Short enough to turn within a session,
   * long enough not to flip on one bar.
   */
  emaPeriod?: number;
  /**
   * Fraction of instruments that must be advancing to call breadth bullish
   * (and its mirror for bearish). 0.6 means a clear majority, not 51% —
   * a near-even split is what NEUTRAL is for.
   */
  breadthThreshold?: number;
  /** Minimum bars before an index is read at all. */
  minBars?: number;
}

const DEFAULTS = {
  emaPeriod: 21,
  breadthThreshold: 0.6,
  minBars: 5,
};

/** Plain EMA over closes, seeded with the first close (plan/18 §3). */
function ema(candles: readonly Candle[], period: number): number | undefined {
  const k = 2 / (period + 1);
  let value: number | undefined;
  for (const candle of candles) {
    value =
      value === undefined ? candle.close : candle.close * k + value * (1 - k);
  }
  return value;
}

/**
 * Session VWAP — typical price weighted by volume (plan/18 §5).
 *
 * Returns undefined when the series carries no volume, which is the normal
 * case for a spot index feed. That is why VWAP is treated as *confirming*
 * evidence below rather than required: demanding it would make every index
 * read NEUTRAL forever, and the gate would quietly never fire.
 */
function vwap(candles: readonly Candle[]): number | undefined {
  let pv = 0;
  let volume = 0;
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    pv += typical * candle.volume;
    volume += candle.volume;
  }
  return volume > 0 ? pv / volume : undefined;
}

/**
 * One index's direction: where its last close sits relative to its own trend,
 * confirmed by VWAP when the feed provides volume.
 *
 * Both available and agreeing → that direction. Disagreeing → NEUTRAL, since
 * price above trend but below VWAP is a market that rose and is being sold
 * into. Only the EMA available → the EMA decides.
 */
export function readIndex(
  symbol: string,
  candles: readonly Candle[],
  config: MarketBiasConfig = {},
): IndexRead | null {
  const minBars = config.minBars ?? DEFAULTS.minBars;
  const last = candles.at(-1);
  if (last === undefined || candles.length < minBars) return null;
  const close = last.close;
  const trend = ema(candles, config.emaPeriod ?? DEFAULTS.emaPeriod);
  const session = vwap(candles);

  const byTrend: MarketBias =
    trend === undefined
      ? "NEUTRAL"
      : close > trend
        ? "BULLISH"
        : close < trend
          ? "BEARISH"
          : "NEUTRAL";
  const byVwap: MarketBias =
    session === undefined
      ? "NEUTRAL"
      : close > session
        ? "BULLISH"
        : close < session
          ? "BEARISH"
          : "NEUTRAL";

  const bias =
    session === undefined
      ? byTrend
      : byTrend === byVwap
        ? byTrend
        : "NEUTRAL";

  return {
    symbol,
    bias,
    close,
    ...(trend === undefined ? {} : { ema: trend }),
    ...(session === undefined ? {} : { vwap: session }),
  };
}

/** Unanimity across the indices; any disagreement is NEUTRAL. */
function combineIndices(reads: readonly IndexRead[]): MarketBias {
  const first = reads.at(0);
  if (first === undefined) return "NEUTRAL";
  return reads.every((read) => read.bias === first.bias)
    ? first.bias
    : "NEUTRAL";
}

/**
 * Breadth: how many instruments are up on the session, not by how much.
 *
 * Counted from each series' first open to its last close, so it is the day's
 * move rather than the last bar's — one red 5-minute bar across the market is
 * noise, a day of them is participation.
 */
function readBreadth(
  series: ReadonlyMap<string, readonly Candle[]>,
  threshold: number,
): { bias: MarketBias; advancing: number; declining: number; unchanged: number } {
  let advancing = 0;
  let declining = 0;
  let unchanged = 0;
  for (const candles of series.values()) {
    const first = candles.at(0);
    const last = candles.at(-1);
    if (first === undefined || last === undefined) continue;
    if (last.close > first.open) advancing += 1;
    else if (last.close < first.open) declining += 1;
    else unchanged += 1;
  }
  const decided = advancing + declining;
  if (decided === 0) {
    return { bias: "NEUTRAL", advancing, declining, unchanged };
  }
  const upShare = advancing / decided;
  const bias: MarketBias =
    upShare >= threshold
      ? "BULLISH"
      : upShare <= 1 - threshold
        ? "BEARISH"
        : "NEUTRAL";
  return { bias, advancing, declining, unchanged };
}

/**
 * Build the market view from index and constituent candles (plan/14 §4).
 *
 * Pure: candles in, verdict out. Every rule above is therefore testable
 * without a feed, which matters because this function can *stop trades* — a
 * gate whose behaviour is hard to pin down is worse than no gate.
 */
export function computeMarketView(input: {
  indexCandles: ReadonlyMap<string, readonly Candle[]>;
  breadthCandles: ReadonlyMap<string, readonly Candle[]>;
  now: number;
  config?: MarketBiasConfig;
}): MarketView {
  const config = input.config ?? {};
  const threshold = config.breadthThreshold ?? DEFAULTS.breadthThreshold;

  const indices: IndexRead[] = [];
  for (const [symbol, candles] of input.indexCandles) {
    const read = readIndex(symbol, candles, config);
    if (read !== null) indices.push(read);
  }
  const indexBias = combineIndices(indices);
  const breadth = readBreadth(input.breadthCandles, threshold);

  if (indices.length === 0 && breadth.advancing + breadth.declining === 0) {
    return { ...UNKNOWN_MARKET_VIEW, ts: input.now };
  }

  // Agreement only. See MarketView's note: each half catches a failure the
  // other is blind to, so a gate built on either alone is not worth blocking on.
  const bias: MarketBias =
    indexBias === breadth.bias && indexBias !== "NEUTRAL"
      ? indexBias
      : "NEUTRAL";

  const indexDetail =
    indices.length === 0
      ? "no index data"
      : indices.map((i) => `${i.symbol}=${i.bias}`).join(" ");

  return {
    bias,
    indexBias,
    breadthBias: breadth.bias,
    indices,
    advancing: breadth.advancing,
    declining: breadth.declining,
    unchanged: breadth.unchanged,
    detail:
      `index ${indexBias} (${indexDetail}); ` +
      `breadth ${breadth.bias} (${String(breadth.advancing)}↑/${String(breadth.declining)}↓)`,
    ts: input.now,
  };
}
