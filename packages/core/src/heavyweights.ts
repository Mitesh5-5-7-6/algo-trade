/**
 * The stocks an index moves with (PLAN.md 14.25, operator 2026-11-28: "Nifty
 * and BankNifty depend on other market stocks; BankNifty depends on the big
 * banks").
 *
 * The largest constituents by index weight — for BANK NIFTY the five banks
 * that carry most of it, for NIFTY 50 the eleven names at the top of its
 * weights. Weights drift month to month and are not stored: what a signal
 * reads is how many of these move WITH it, a count that needs no weight.
 * Review the lists against NSE's monthly index factsheets.
 */
export const INDEX_HEAVYWEIGHTS = {
  NIFTY: [
    "NSE:HDFCBANK-EQ",
    "NSE:ICICIBANK-EQ",
    "NSE:RELIANCE-EQ",
    "NSE:INFY-EQ",
    "NSE:BHARTIARTL-EQ",
    "NSE:LT-EQ",
    "NSE:ITC-EQ",
    "NSE:TCS-EQ",
    "NSE:AXISBANK-EQ",
    "NSE:SBIN-EQ",
    "NSE:KOTAKBANK-EQ",
  ],
  BANKNIFTY: [
    "NSE:HDFCBANK-EQ",
    "NSE:ICICIBANK-EQ",
    "NSE:SBIN-EQ",
    "NSE:KOTAKBANK-EQ",
    "NSE:AXISBANK-EQ",
  ],
} as const satisfies Record<string, readonly string[]>;

export type HeavyweightIndex = keyof typeof INDEX_HEAVYWEIGHTS;

/** Every heavyweight once — what the feed subscribes for data. */
export const ALL_HEAVYWEIGHTS: readonly string[] = [
  ...new Set(Object.values(INDEX_HEAVYWEIGHTS).flat()),
];

/** The heavyweights of an underlying ("NIFTY", "BANKNIFTY"); empty for any other. */
export function heavyweightsOf(underlying: string): readonly string[] {
  return underlying in INDEX_HEAVYWEIGHTS
    ? INDEX_HEAVYWEIGHTS[underlying as HeavyweightIndex]
    : [];
}

/** A heavyweight's prices on the day: yesterday's close and the latest. */
export interface HeavyweightQuote {
  prevClose: number;
  last: number;
}

/** A move smaller than this, in percent, counts as unchanged. */
export const HEAVYWEIGHT_FLAT_PCT = 0.05;

export interface HeavyweightBreadth {
  underlying: string;
  /** Heavyweights with a quote. */
  total: number;
  up: number;
  down: number;
  flat: number;
  /** The average change from yesterday's close, in percent. */
  avgChangePct: number;
  moves: Array<{ symbol: string; changePct: number }>;
}

/**
 * How the underlying's heavyweights stand against yesterday's close.
 *
 * Null when fewer than half of them have a quote: "2 of 2 up" read off a
 * basket of eleven is the 1-of-1 trap the market-bias gate fell into once.
 */
export function heavyweightBreadth(
  underlying: string,
  quotes: ReadonlyMap<string, HeavyweightQuote>,
): HeavyweightBreadth | null {
  const names = heavyweightsOf(underlying);
  const moves: Array<{ symbol: string; changePct: number }> = [];
  for (const symbol of names) {
    const q = quotes.get(symbol);
    if (q === undefined || !(q.prevClose > 0) || !(q.last > 0)) continue;
    moves.push({
      symbol,
      changePct: ((q.last - q.prevClose) / q.prevClose) * 100,
    });
  }
  if (names.length === 0 || moves.length * 2 < names.length) return null;
  const up = moves.filter((m) => m.changePct >= HEAVYWEIGHT_FLAT_PCT).length;
  const down = moves.filter((m) => m.changePct <= -HEAVYWEIGHT_FLAT_PCT).length;
  return {
    underlying,
    total: moves.length,
    up,
    down,
    flat: moves.length - up - down,
    avgChangePct: moves.reduce((s, m) => s + m.changePct, 0) / moves.length,
    moves,
  };
}
