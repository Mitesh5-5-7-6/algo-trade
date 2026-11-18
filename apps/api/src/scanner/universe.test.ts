import { describe, expect, it } from "vitest";
import { buildUniverse } from "./universe.js";

const DAY = 86_400_000;
/** 2026-11-17 09:00 IST. */
const AS_OF = Date.UTC(2026, 10, 17, 3, 30);
const expiryIn = (days: number): number =>
  Math.floor((AS_OF + days * DAY) / 1000);

/** A futures row of NSE_FO.csv, in the live layout (verified 2026-11-17). */
function future(
  underlying: string,
  month: string,
  expirySeconds: number,
  lot: number,
  underlyingFyToken: string,
  type = 13,
): string {
  return [
    `1011261123${String(lot)}`,
    `${underlying} 23 ${month} 26 FUT`,
    String(type),
    String(lot),
    "0.1",
    "",
    "0915-1540|1815-1915:",
    "2026-11-16",
    String(expirySeconds),
    `NSE:${underlying}26${month.toUpperCase()}FUT`,
    "10",
    "11",
    "61697",
    underlying,
    "2885",
    "-1.0",
    "XX",
    underlyingFyToken,
    "None",
    "0",
    "0.0",
  ].join(",");
}

/** An option row: same file, never part of the universe. */
const OPTION =
  "101126112361999,RELIANCE 23 Nov 26 1300 CE,14,500,0.05,,0915-1530:,2026-11-16," +
  `${String(expiryIn(6))},NSE:RELIANCE26NOV1300CE,10,11,61999,RELIANCE,2885,1300.0,CE,10100000002885,None,0,0.0`;

/** A row of NSE_CM.csv: its fyToken first, its symbol tenth. */
const cash = (fyToken: string, name: string, symbol: string, lot = 1): string =>
  `${fyToken},${name},0,${String(lot)},0.1,INE000A00000,0915-1530|1815-1915:,2026-11-16,,${symbol},10,10,2885,${name},2885,-1.0,XX,${fyToken},None,1,3.6`;

const CM = [
  cash("10100000002885", "RELIANCE", "NSE:RELIANCE-EQ"),
  cash("10100000001594", "INFY", "NSE:INFY-EQ"),
  cash("101000000026009", "NIFTYBANK-INDEX", "NSE:NIFTYBANK-INDEX", 0),
  cash("10100000009999", "OLDCO", "NSE:OLDCO-EQ"),
].join("\n");

const build = (fo: string[], minDaysToExpiry = 2) =>
  buildUniverse(
    { fo: fo.join("\n"), cm: CM },
    { asOf: AS_OF, minDaysToExpiry },
  );

describe("the scanner's universe (18.2)", () => {
  it("takes each F&O underlying once, with the symbol whose bars are scanned", () => {
    const universe = build([
      future("RELIANCE", "Nov", expiryIn(6), 500, "10100000002885"),
      future("RELIANCE", "Dec", expiryIn(34), 500, "10100000002885"),
      OPTION,
      future("BANKNIFTY", "Nov", expiryIn(6), 30, "101000000026009", 11),
      future("INFY", "Nov", expiryIn(6), 400, "10100000001594"),
    ]);
    expect(universe.members).toEqual([
      {
        underlying: "BANKNIFTY",
        kind: "INDEX",
        symbol: "NSE:NIFTYBANK-INDEX",
        future: "NSE:BANKNIFTY26NOVFUT",
        expiry: expiryIn(6) * 1000,
        lotSize: 30,
      },
      {
        underlying: "INFY",
        kind: "STOCK",
        symbol: "NSE:INFY-EQ",
        future: "NSE:INFY26NOVFUT",
        expiry: expiryIn(6) * 1000,
        lotSize: 400,
      },
      {
        underlying: "RELIANCE",
        kind: "STOCK",
        symbol: "NSE:RELIANCE-EQ",
        future: "NSE:RELIANCE26NOVFUT",
        expiry: expiryIn(6) * 1000,
        lotSize: 500,
      },
    ]);
    expect(universe.rejected).toEqual([]);
    expect(universe).toMatchObject({ asOf: AS_OF, minDaysToExpiry: 2 });
  });

  it("passes over a contract inside the minimum time to expiry for the next one", () => {
    // Tomorrow's expiry is inside two days; December's is the contract.
    const universe = build([
      future("RELIANCE", "Nov", expiryIn(1), 500, "10100000002885"),
      future("RELIANCE", "Dec", expiryIn(29), 550, "10100000002885"),
    ]);
    expect(universe.members).toMatchObject([
      { underlying: "RELIANCE", future: "NSE:RELIANCE26DECFUT", lotSize: 550 },
    ]);
    // With no minimum, the near contract stands.
    expect(
      build(
        [
          future("RELIANCE", "Nov", expiryIn(1), 500, "10100000002885"),
          future("RELIANCE", "Dec", expiryIn(29), 550, "10100000002885"),
        ],
        0,
      ).members[0]?.future,
    ).toBe("NSE:RELIANCE26NOVFUT");
  });

  it("rejects, with its reason, an underlying with no contract left to trade", () => {
    const universe = build([
      future("RELIANCE", "Nov", expiryIn(-3), 500, "10100000002885"),
      future("INFY", "Nov", expiryIn(1), 400, "10100000001594"),
    ]);
    expect(universe.members).toEqual([]);
    expect(universe.rejected).toEqual([
      {
        underlying: "INFY",
        reason: "NO_ELIGIBLE_CONTRACT",
        detail: "its 1 unexpired future(s) expire within 2 day(s) of the scan",
      },
      {
        underlying: "RELIANCE",
        reason: "NO_ELIGIBLE_CONTRACT",
        detail: "every listed future has expired",
      },
    ]);
  });

  it("rejects an underlying whose bars it cannot name", () => {
    const universe = build([
      future("NEWCO", "Nov", expiryIn(6), 100, "10100000007777"),
    ]);
    expect(universe.members).toEqual([]);
    expect(universe.rejected).toEqual([
      {
        underlying: "NEWCO",
        reason: "NO_DATA_SYMBOL",
        detail:
          "its underlying token 10100000007777 is not in the cash file, so no symbol's bars can be read for it",
      },
    ]);
  });

  it("counts the rows it could not read rather than guessing at them", () => {
    const universe = build([
      future("RELIANCE", "Nov", expiryIn(6), 500, "10100000002885"),
      "not,a,row",
      "101126112361697,BROKEN 23 Nov 26 FUT,13,abc,0.1,,x,2026-11-16,1,NSE:BROKEN26NOVFUT,10,11,1,BROKEN,1,-1.0,XX,1,None,0,0.0",
    ]);
    expect(universe.members).toHaveLength(1);
    expect(universe.unreadableRows).toBe(2);
  });

  it("is the same universe whatever order the rows come in", () => {
    const rows = [
      future("RELIANCE", "Dec", expiryIn(34), 500, "10100000002885"),
      future("INFY", "Nov", expiryIn(6), 400, "10100000001594"),
      future("RELIANCE", "Nov", expiryIn(6), 500, "10100000002885"),
      future("BANKNIFTY", "Nov", expiryIn(6), 30, "101000000026009", 11),
    ];
    expect(build([...rows].reverse())).toEqual(build(rows));
  });
});
