import { parseInstrumentRow } from "@neelkanth/broker";

/** Bumped whenever the same symbol files would give a different universe. */
export const SCAN_UNIVERSE_VERSION = "1";

const DAY_MS = 86_400_000;

/**
 * Columns this module reads itself, 0-based, verified against live rows of
 * both files on 2026-11-17:
 *
 * ```
 * NSE_FO  …,NSE:BANKNIFTY26NOVFUT,10,11,61466,BANKNIFTY,26009,-1.0,XX,101000000026009,…
 * NSE_CM  101000000026009,NIFTYBANK-INDEX,10,0,0.05,…,NSE:NIFTYBANK-INDEX,…
 * ```
 *
 * A derivative's row ends its contract facts with the fyToken of what it
 * derives from, and that token is the first column of the underlying's own
 * row in the cash file. Joining on it is how an underlying's name —
 * `BANKNIFTY` — becomes the symbol whose bars exist — `NSE:NIFTYBANK-INDEX` —
 * without a table of names kept by hand.
 */
const FO_UNDERLYING_FYTOKEN = 17;
const CM_FYTOKEN = 0;
const CM_SYMBOL = 9;

/** One underlying the scan will look at. */
export interface UniverseMember {
  /** The F&O underlying's name, e.g. `BANKNIFTY`, `RELIANCE`. */
  underlying: string;
  kind: "INDEX" | "STOCK";
  /** The symbol whose bars are scanned: the index, or the cash equity. */
  symbol: string;
  /** The nearest future outside the minimum time to expiry. */
  future: string;
  /** That future's expiry, epoch ms. */
  expiry: number;
  lotSize: number;
}

export interface UniverseRejection {
  underlying: string;
  /**
   * `NO_ELIGIBLE_CONTRACT` — every future has expired, or expires inside the
   * minimum time. `NO_DATA_SYMBOL` — the cash file does not hold its
   * underlying, so there are no bars to read for it.
   */
  reason: "NO_ELIGIBLE_CONTRACT" | "NO_DATA_SYMBOL";
  detail: string;
}

export interface ScanUniverse {
  asOf: number;
  minDaysToExpiry: number;
  /** By underlying, A to Z. */
  members: UniverseMember[];
  rejected: UniverseRejection[];
  /** Futures rows of the F&O file that could not be read with confidence. */
  unreadableRows: number;
}

export interface UniverseOptions {
  /** When the scan is made, epoch ms. Contracts are judged against it. */
  asOf: number;
  /** A contract expiring within this many days of `asOf` is passed over. */
  minDaysToExpiry: number;
}

/**
 * The scanner's universe (design §7.1 D1): every F&O underlying with a future
 * still worth trading, and the symbol whose bars the scan reads for it.
 *
 * From the broker's two public symbol files, as text — the same files the
 * trading process builds its instrument master from. Pure: the same files
 * and options give the same universe, whatever order the rows come in.
 *
 * Every underlying in the F&O file comes out either a member or a rejection
 * with its reason (D3); none is dropped silently.
 */
export function buildUniverse(
  files: { fo: string; cm: string },
  options: UniverseOptions,
): ScanUniverse {
  const cashSymbols = new Map<string, string>();
  for (const row of files.cm.split("\n")) {
    const cols = row.split(",");
    const token = cols[CM_FYTOKEN]?.trim();
    const symbol = cols[CM_SYMBOL]?.trim();
    if (token && symbol) cashSymbols.set(token, symbol);
  }

  interface Contract {
    symbol: string;
    expiry: number;
    lotSize: number;
    underlyingFyToken: string;
  }
  const futures = new Map<string, Contract[]>();
  let unreadableRows = 0;
  for (const row of files.fo.split("\n")) {
    // Only futures matter, and a future's symbol ends `FUT`: some 700 of the
    // file's 92,000 rows. Skipping the options before parsing them keeps a
    // scan inside a small research instance's memory (2026-11-19).
    if (!row.includes("FUT,")) continue;
    const instrument = parseInstrumentRow(row);
    if (instrument === null) {
      unreadableRows += 1;
      continue;
    }
    if (instrument.kind !== "FUTURE") continue;
    const underlyingFyToken = row.split(",")[FO_UNDERLYING_FYTOKEN]?.trim();
    if (
      instrument.underlying === undefined ||
      instrument.expiry === undefined ||
      !underlyingFyToken
    ) {
      unreadableRows += 1;
      continue;
    }
    const contracts = futures.get(instrument.underlying) ?? [];
    contracts.push({
      symbol: instrument.symbol,
      expiry: instrument.expiry,
      lotSize: instrument.lotSize,
      underlyingFyToken,
    });
    futures.set(instrument.underlying, contracts);
  }

  const earliest = options.asOf + options.minDaysToExpiry * DAY_MS;
  const members: UniverseMember[] = [];
  const rejected: UniverseRejection[] = [];
  for (const underlying of [...futures.keys()].sort()) {
    const contracts = (futures.get(underlying) ?? []).sort(
      (a, b) => a.expiry - b.expiry || a.symbol.localeCompare(b.symbol),
    );
    const unexpired = contracts.filter((c) => c.expiry > options.asOf);
    const contract = unexpired.find((c) => c.expiry > earliest);
    if (contract === undefined) {
      rejected.push({
        underlying,
        reason: "NO_ELIGIBLE_CONTRACT",
        detail:
          unexpired.length === 0
            ? "every listed future has expired"
            : `its ${String(unexpired.length)} unexpired future(s) expire within ${String(options.minDaysToExpiry)} day(s) of the scan`,
      });
      continue;
    }
    const symbol = cashSymbols.get(contract.underlyingFyToken);
    if (symbol === undefined) {
      rejected.push({
        underlying,
        reason: "NO_DATA_SYMBOL",
        detail: `its underlying token ${contract.underlyingFyToken} is not in the cash file, so no symbol's bars can be read for it`,
      });
      continue;
    }
    members.push({
      underlying,
      kind: symbol.endsWith("-INDEX") ? "INDEX" : "STOCK",
      symbol,
      future: contract.symbol,
      expiry: contract.expiry,
      lotSize: contract.lotSize,
    });
  }
  return {
    asOf: options.asOf,
    minDaysToExpiry: options.minDaysToExpiry,
    members,
    rejected,
    unreadableRows,
  };
}
