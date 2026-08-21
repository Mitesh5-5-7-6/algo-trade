import {
  InstrumentSchema,
  type Instrument,
  type OptionType,
} from "@neelkanth/core";

/**
 * The FYERS symbol master — the authoritative source for lot size, tick size,
 * expiry and strike (plan/17 §7).
 *
 * FYERS publishes it as headerless CSV, one file per exchange segment, updated
 * daily:
 *
 *   https://public.fyers.in/sym_details/NSE_FO.csv   (NSE derivatives)
 *   https://public.fyers.in/sym_details/NSE_CM.csv   (NSE cash)
 *   https://public.fyers.in/sym_details/BSE_FO.csv   (BSE derivatives — SENSEX)
 *
 * Reading lot sizes from here rather than from constants is not fastidiousness.
 * Verified 2026-08-21: NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120,
 * SENSEX 20 — every one of which has been a different number in the past. A
 * stale constant does not fail loudly; it sizes every order wrongly, forever.
 */

/**
 * Column positions, 0-based, verified against live rows on 2026-08-21:
 *
 * ```
 * 101126082558067,BANKNIFTY 25 Aug 26 FUT,11,30,0.2,,0915-…,2026-08-20,
 * 1787652600,NSE:BANKNIFTY26AUGFUT,10,11,58067,BANKNIFTY,26009,-1.0,XX,…
 * ```
 *
 * The file is headerless, so these indices ARE the contract. If FYERS changes
 * the layout, `parseInstrumentRow` returns null rather than mis-reading a lot
 * size — a dropped instrument is recoverable, a wrong multiplier is not.
 */
const COL = {
  lotSize: 3,
  tickSize: 4,
  expirySeconds: 8,
  symbol: 9,
  underlying: 13,
  strike: 15,
  optionType: 16,
} as const;

/** Futures carry `XX` in the option-type column and `-1` as the strike. */
const FUTURE_OPTION_TYPE = "XX";

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse one symbol-master row into an {@link Instrument}.
 *
 * Returns null for anything it cannot read with confidence — a short row, a
 * non-numeric lot size, an unrecognized option type. Deliberately strict: this
 * feeds position sizing, so a half-understood row must be discarded rather
 * than guessed at (plan/02 §10).
 */
export function parseInstrumentRow(row: string): Instrument | null {
  const cells = row.split(",");
  if (cells.length <= COL.optionType) return null;

  const symbol = cells[COL.symbol]?.trim();
  const lotSize = num(cells[COL.lotSize]);
  const tickSize = num(cells[COL.tickSize]);
  if (
    symbol === undefined ||
    symbol === "" ||
    lotSize === null ||
    lotSize <= 0 ||
    tickSize === null ||
    tickSize <= 0
  ) {
    return null;
  }

  const optionTypeCell = cells[COL.optionType]?.trim() ?? "";
  const underlying = cells[COL.underlying]?.trim();
  const expirySeconds = num(cells[COL.expirySeconds]);
  const strike = num(cells[COL.strike]);

  // The three shapes, distinguished by the option-type column.
  const candidate =
    optionTypeCell === "CE" || optionTypeCell === "PE"
      ? {
          symbol,
          kind: "OPTION" as const,
          lotSize,
          tickSize,
          ...(underlying === undefined || underlying === ""
            ? {}
            : { underlying }),
          ...(expirySeconds === null ? {} : { expiry: expirySeconds * 1000 }),
          ...(strike === null || strike <= 0 ? {} : { strike }),
          optionType: optionTypeCell satisfies OptionType,
        }
      : optionTypeCell === FUTURE_OPTION_TYPE
        ? {
            symbol,
            kind: "FUTURE" as const,
            lotSize,
            tickSize,
            ...(underlying === undefined || underlying === ""
              ? {}
              : { underlying }),
            ...(expirySeconds === null ? {} : { expiry: expirySeconds * 1000 }),
          }
        : { symbol, kind: "EQUITY" as const, lotSize, tickSize };

  const parsed = InstrumentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Instrument lookup, as the rest of the system needs it. An interface so the
 * risk engine and signal resolution depend on the question, not on FYERS's CSV
 * (plan/03 §5): a fake in tests, and a different broker later, both satisfy it.
 */
export interface InstrumentMaster {
  /** The contract this symbol names, or null if unknown. */
  get(symbol: string): Instrument | null;
  /**
   * The front-month future for `underlying` — the nearest expiry still in the
   * future at `now`. Null when the underlying has no listed future.
   */
  nearestFuture(underlying: string, now: number): Instrument | null;
  /**
   * The option nearest `spot`, `strikeOffset` strikes away, at the nearest
   * unexpired expiry. Offset is in strikes, signed toward out-of-the-money:
   * 0 is ATM, +1 is one strike OTM for the given side.
   */
  nearestOption(
    underlying: string,
    spot: number,
    optionType: OptionType,
    now: number,
    strikeOffset?: number,
  ): Instrument | null;
  /** How many contracts are indexed — for a boot log worth reading. */
  readonly size: number;
}

/** Nearest unexpired expiry among `instruments`, or null if all have expired. */
function nearestExpiry(
  instruments: readonly Instrument[],
  now: number,
): number | null {
  let best: number | null = null;
  for (const instrument of instruments) {
    const expiry = instrument.expiry;
    if (expiry === undefined || expiry <= now) continue;
    if (best === null || expiry < best) best = expiry;
  }
  return best;
}

/**
 * Build the lookup from parsed instruments.
 *
 * Pure — takes rows, holds no I/O — so every selection rule below is testable
 * without touching the network or a 15MB download.
 */
export function createInstrumentMaster(
  instruments: readonly Instrument[],
): InstrumentMaster {
  const bySymbol = new Map<string, Instrument>();
  const futuresByUnderlying = new Map<string, Instrument[]>();
  const optionsByUnderlying = new Map<string, Instrument[]>();

  for (const instrument of instruments) {
    bySymbol.set(instrument.symbol, instrument);
    const underlying = instrument.underlying;
    if (underlying === undefined) continue;
    const bucket =
      instrument.kind === "FUTURE"
        ? futuresByUnderlying
        : instrument.kind === "OPTION"
          ? optionsByUnderlying
          : null;
    if (bucket === null) continue;
    const list = bucket.get(underlying) ?? [];
    list.push(instrument);
    bucket.set(underlying, list);
  }

  return {
    size: bySymbol.size,

    get: (symbol) => bySymbol.get(symbol) ?? null,

    nearestFuture(underlying, now) {
      const candidates = futuresByUnderlying.get(underlying) ?? [];
      const expiry = nearestExpiry(candidates, now);
      if (expiry === null) return null;
      return candidates.find((c) => c.expiry === expiry) ?? null;
    },

    nearestOption(underlying, spot, optionType, now, strikeOffset = 0) {
      const all = optionsByUnderlying.get(underlying) ?? [];
      const expiry = nearestExpiry(all, now);
      if (expiry === null) return null;

      // One expiry and one side only — mixing expiries would silently pick a
      // far-month contract whenever the near one lacks a strike.
      const chain = all
        .filter((c) => c.expiry === expiry && c.optionType === optionType)
        .filter((c) => c.strike !== undefined)
        .sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0));
      if (chain.length === 0) return null;

      // ATM = the listed strike closest to spot. Ties break to the lower
      // strike, deterministically, so the same input never picks differently.
      let atm = 0;
      let bestDistance = Infinity;
      for (const [index, option] of chain.entries()) {
        const distance = Math.abs((option.strike ?? 0) - spot);
        if (distance < bestDistance) {
          bestDistance = distance;
          atm = index;
        }
      }

      // Offset moves out-of-the-money: up the chain for calls, down for puts.
      const direction = optionType === "CE" ? 1 : -1;
      const index = atm + direction * strikeOffset;
      return chain[index] ?? null;
    },
  };
}

/**
 * Parse a whole symbol-master file, skipping rows that cannot be read.
 *
 * The count of skipped rows is returned rather than logged here: this stays
 * pure, and the caller decides whether a high skip count is worth shouting
 * about (a layout change would show up as most of the file being skipped).
 */
export function parseInstrumentFile(csv: string): {
  instruments: Instrument[];
  skipped: number;
} {
  const instruments: Instrument[] = [];
  let skipped = 0;
  for (const line of csv.split("\n")) {
    if (line.trim() === "") continue;
    const instrument = parseInstrumentRow(line);
    if (instrument === null) skipped += 1;
    else instruments.push(instrument);
  }
  return { instruments, skipped };
}
