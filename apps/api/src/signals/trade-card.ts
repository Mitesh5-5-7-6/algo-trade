import {
  TradeCardSchema,
  type Instrument,
  type Signal,
  type TradeCard,
} from "@neelkanth/core";

/**
 * How far an at-the-money option's premium moves per point of its index —
 * the assumption behind an `INDEX_SUGGESTED` card's premium stop and target.
 * Near 0.5 is the textbook value at the money; the card says it is assumed.
 */
export const ASSUMED_ATM_DELTA = 0.5;

/** The smallest premium the card will name as a stop: NSE's option tick. */
const MIN_PREMIUM = 0.05;

/**
 * The option underlying the symbol master uses for an index symbol, e.g.
 * `NSE:NIFTYBANK-INDEX` → `BANKNIFTY`; null for anything that is not an index.
 * The two whose names differ are spelled out; the rest drop the decoration
 * (`NSE:FINNIFTY-INDEX` → `FINNIFTY`) — the broker's own convention, the
 * reverse of its `FYERS_INDEX_SYMBOLS`.
 */
export function optionUnderlyingOf(symbol: string): string | null {
  if (symbol === "NSE:NIFTY50-INDEX") return "NIFTY";
  if (symbol === "NSE:NIFTYBANK-INDEX") return "BANKNIFTY";
  const match = /^NSE:([A-Z0-9]+)-INDEX$/.exec(symbol);
  return match?.[1] ?? null;
}

export interface TradeCardContext {
  strategyName: string;
  /**
   * For an index signal: the at-the-money option the card suggests (a call
   * for a buy, a put for a sell), or null when none could be found. For an
   * option strategy's signal: its own contract, when the master knows it.
   */
  contract: Instrument | null;
  /** That contract's live price, or null when it is not streaming. */
  premium: number | null;
  delta?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The card for one approved entry. Pure: the runtime looks the contract and
 * its price up, this only arranges them.
 *
 * Returns null for anything that is not an entry — an exit, or a HOLD — which
 * gets no card.
 */
export function buildTradeCard(
  signal: Signal,
  context: TradeCardContext,
): TradeCard | null {
  if (
    signal.side === "HOLD" ||
    signal.exitReason !== undefined ||
    signal.positionId !== undefined
  )
    return null;
  const price = signal.contextSnapshot.price;
  const common = {
    signalId: signal.signalId,
    strategyId: signal.strategyId,
    strategyName: context.strategyName,
    ts: signal.ts,
    reason: signal.reason,
  };

  // An option strategy already traded a contract: its numbers are the order's.
  if (signal.underlyingSymbol !== undefined) {
    const optionType = optionTypeOf(signal.symbol, context.contract);
    return finish({
      ...common,
      basis: "OPTION_STRATEGY",
      underlying: signal.underlyingSymbol,
      direction: optionType === "PE" ? "BEARISH" : "BULLISH",
      contract: signal.symbol,
      optionType,
      strike: context.contract?.strike ?? null,
      expiry: context.contract?.expiry ?? null,
      lotSize: context.contract?.lotSize ?? null,
      action: "BUY",
      entry: price,
      stopLoss: signal.stopLoss ?? null,
      target: signal.target ?? null,
      estimated: false,
      assumedDelta: null,
      index: null,
      note: null,
    });
  }

  const direction: TradeCard["direction"] =
    signal.side === "BUY" ? "BULLISH" : "BEARISH";

  // A stock, or anything not an index, is traded as itself.
  if (optionUnderlyingOf(signal.symbol) === null) {
    return finish({
      ...common,
      basis: "DIRECT",
      underlying: signal.symbol,
      direction,
      contract: signal.symbol,
      optionType: null,
      strike: null,
      expiry: null,
      lotSize: null,
      action: signal.side,
      entry: price,
      stopLoss: signal.stopLoss ?? null,
      target: signal.target ?? null,
      estimated: false,
      assumedDelta: null,
      index: null,
      note: null,
    });
  }

  // An index decision, suggested as the at-the-money option.
  const index = {
    entry: price,
    stopLoss: signal.stopLoss ?? null,
    target: signal.target ?? null,
  };
  const optionType: "CE" | "PE" = direction === "BULLISH" ? "CE" : "PE";
  const base = {
    ...common,
    basis: "INDEX_SUGGESTED" as const,
    underlying: signal.symbol,
    direction,
    optionType,
    action: "BUY" as const,
    index,
  };
  if (context.contract === null)
    return finish({
      ...base,
      contract: null,
      strike: null,
      expiry: null,
      lotSize: null,
      entry: null,
      stopLoss: null,
      target: null,
      estimated: false,
      assumedDelta: null,
      note: `no ${optionType} contract found for ${signal.symbol} in the instrument master; the index levels stand alone`,
    });
  const contract = {
    contract: context.contract.symbol,
    strike: context.contract.strike ?? null,
    expiry: context.contract.expiry ?? null,
    lotSize: context.contract.lotSize,
  };
  if (context.premium === null || context.premium <= 0)
    return finish({
      ...base,
      ...contract,
      entry: null,
      stopLoss: null,
      target: null,
      estimated: false,
      assumedDelta: null,
      note: `${context.contract.symbol} is not streaming, so its premium is unknown; the index levels stand alone`,
    });

  const delta = context.delta ?? ASSUMED_ATM_DELTA;
  const premium = context.premium;
  // The index moving AGAINST the trade by its stop distance takes this much
  // off the premium — for a call and for a put alike, since each is bought.
  const stopMove =
    index.stopLoss === null ? null : Math.abs(price - index.stopLoss) * delta;
  const targetMove =
    index.target === null ? null : Math.abs(index.target - price) * delta;
  const rawStop = stopMove === null ? null : premium - stopMove;
  const floored = rawStop !== null && rawStop < MIN_PREMIUM;
  return finish({
    ...base,
    ...contract,
    entry: round2(premium),
    stopLoss: rawStop === null ? null : round2(floored ? MIN_PREMIUM : rawStop),
    target: targetMove === null ? null : round2(premium + targetMove),
    estimated: true,
    assumedDelta: delta,
    note: floored
      ? `the index stop is wider than the premium can fall at delta ${String(delta)}: the stop is the premium going to ${String(MIN_PREMIUM)}`
      : null,
  });
}

/** Adds the distances and the reward-to-risk, rounds, and checks the shape. */
function finish(
  card: Omit<TradeCard, "stopPoints" | "targetPoints" | "rewardRisk">,
): TradeCard {
  const stopPoints =
    card.entry === null || card.stopLoss === null
      ? null
      : round2(Math.abs(card.entry - card.stopLoss));
  const targetPoints =
    card.entry === null || card.target === null
      ? null
      : round2(Math.abs(card.target - card.entry));
  const rewardRisk =
    stopPoints === null || targetPoints === null || stopPoints === 0
      ? null
      : round2(targetPoints / stopPoints);
  return TradeCardSchema.parse({
    ...card,
    entry: card.entry === null ? null : round2(card.entry),
    stopLoss: card.stopLoss === null ? null : round2(card.stopLoss),
    target: card.target === null ? null : round2(card.target),
    stopPoints,
    targetPoints,
    rewardRisk,
  });
}

function optionTypeOf(
  symbol: string,
  contract: Instrument | null,
): "CE" | "PE" | null {
  if (contract?.optionType !== undefined) return contract.optionType;
  if (symbol.endsWith("CE")) return "CE";
  if (symbol.endsWith("PE")) return "PE";
  return null;
}
