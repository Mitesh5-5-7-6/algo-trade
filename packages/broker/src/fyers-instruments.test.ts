import { describe, expect, it } from "vitest";
import { floorToLots, notionalPerLot } from "@neelkanth/core";
import {
  createInstrumentMaster,
  parseInstrumentFile,
  parseInstrumentRow,
} from "./fyers-instruments.js";

/**
 * REAL rows, copied verbatim from https://public.fyers.in/sym_details on
 * 2026-08-21. The file is headerless, so column positions are the entire
 * contract — a fixture invented by hand would prove nothing about them.
 */
const BANKNIFTY_FUT =
  "101126082558067,BANKNIFTY 25 Aug 26 FUT,11,30,0.2,,0915-1540|1815-1915:,2026-08-20,1787652600,NSE:BANKNIFTY26AUGFUT,10,11,58067,BANKNIFTY,26009,-1.0,XX,101000000026009,None,0,0.0";
const BANKNIFTY_CE =
  "101126082535011,BANKNIFTY 25 Aug 26 39900 CE,14,30,0.05,,0915-1540|1815-1915:,2026-08-20,1787652600,NSE:BANKNIFTY26AUG39900CE,10,11,35011,BANKNIFTY,26009,39900.0,CE,101000000026009,None,0,0.0";

describe("parseInstrumentRow (columns verified against live data)", () => {
  it("reads a futures row", () => {
    expect(parseInstrumentRow(BANKNIFTY_FUT)).toEqual({
      symbol: "NSE:BANKNIFTY26AUGFUT",
      kind: "FUTURE",
      lotSize: 30,
      tickSize: 0.2,
      underlying: "BANKNIFTY",
      expiry: 1_787_652_600_000, // seconds in the file, ms in the domain
    });
  });

  it("reads an options row, including strike and side", () => {
    expect(parseInstrumentRow(BANKNIFTY_CE)).toEqual({
      symbol: "NSE:BANKNIFTY26AUG39900CE",
      kind: "OPTION",
      lotSize: 30,
      tickSize: 0.05,
      underlying: "BANKNIFTY",
      expiry: 1_787_652_600_000,
      strike: 39_900,
      optionType: "CE",
    });
  });

  it("gives no strike or option type to a future", () => {
    // `-1.0` in the strike column and `XX` as the type mean "not applicable".
    // Carrying them through as data would make a future look like a strange
    // option to everything downstream.
    const future = parseInstrumentRow(BANKNIFTY_FUT);
    expect(future?.strike).toBeUndefined();
    expect(future?.optionType).toBeUndefined();
  });

  it("discards a row it cannot read rather than guessing", () => {
    // A dropped instrument is recoverable; a wrong lot size silently mis-sizes
    // every order placed on it.
    expect(parseInstrumentRow("")).toBeNull();
    expect(parseInstrumentRow("too,few,columns")).toBeNull();
    expect(
      parseInstrumentRow(BANKNIFTY_FUT.replace(",30,0.2,", ",notanumber,0.2,")),
    ).toBeNull();
    expect(parseInstrumentRow(BANKNIFTY_FUT.replace(",30,0.2,", ",0,0.2,"))).toBeNull();
  });

  it("counts skipped rows so a layout change is visible", () => {
    const { instruments, skipped } = parseInstrumentFile(
      [BANKNIFTY_FUT, "garbage", BANKNIFTY_CE, ""].join("\n"),
    );
    expect(instruments).toHaveLength(2);
    expect(skipped).toBe(1);
  });
});

/** A small synthetic chain — one expiry near, one far — for selection rules. */
const NEAR = 2_000_000_000_000;
const FAR = 2_000_600_000_000;
const NOW = 1_999_000_000_000;

function option(strike: number, optionType: "CE" | "PE", expiry: number) {
  return {
    symbol: `NSE:NIFTY-${String(strike)}${optionType}-${String(expiry)}`,
    kind: "OPTION" as const,
    lotSize: 65,
    tickSize: 0.05,
    underlying: "NIFTY",
    expiry,
    strike,
    optionType,
  };
}

const CHAIN = [
  option(24_400, "CE", NEAR),
  option(24_500, "CE", NEAR),
  option(24_600, "CE", NEAR),
  option(24_700, "CE", NEAR),
  option(24_500, "PE", NEAR),
  option(24_600, "PE", NEAR),
  option(24_500, "CE", FAR), // far month — must never be chosen while NEAR lives
  {
    symbol: "NSE:NIFTY26AUGFUT",
    kind: "FUTURE" as const,
    lotSize: 65,
    tickSize: 0.05,
    underlying: "NIFTY",
    expiry: NEAR,
  },
  {
    symbol: "NSE:NIFTY26SEPFUT",
    kind: "FUTURE" as const,
    lotSize: 65,
    tickSize: 0.05,
    underlying: "NIFTY",
    expiry: FAR,
  },
];

describe("instrument selection", () => {
  const master = createInstrumentMaster(CHAIN);

  it("picks the front-month future", () => {
    expect(master.nearestFuture("NIFTY", NOW)?.symbol).toBe(
      "NSE:NIFTY26AUGFUT",
    );
  });

  it("rolls to the next expiry once the near one has passed", () => {
    // Expiry rolling falls out of resolving at signal time: past the near
    // expiry, the same call returns the next contract with no config change.
    expect(master.nearestFuture("NIFTY", NEAR + 1)?.symbol).toBe(
      "NSE:NIFTY26SEPFUT",
    );
  });

  it("returns null for an underlying with no listed contract", () => {
    expect(master.nearestFuture("NOTLISTED", NOW)).toBeNull();
  });

  it("picks the ATM strike closest to spot", () => {
    expect(master.nearestOption("NIFTY", 24_580, "CE", NOW)?.strike).toBe(
      24_600,
    );
    expect(master.nearestOption("NIFTY", 24_520, "CE", NOW)?.strike).toBe(
      24_500,
    );
  });

  it("never crosses into a later expiry while the near one is listed", () => {
    const picked = master.nearestOption("NIFTY", 24_500, "CE", NOW);
    expect(picked?.expiry).toBe(NEAR);
  });

  it("moves the offset out-of-the-money — up for calls, down for puts", () => {
    expect(
      master.nearestOption("NIFTY", 24_500, "CE", NOW, 1)?.strike,
    ).toBe(24_600);
    expect(
      master.nearestOption("NIFTY", 24_600, "PE", NOW, 1)?.strike,
    ).toBe(24_500);
  });

  it("returns null rather than a wrong strike when the offset runs off the chain", () => {
    expect(master.nearestOption("NIFTY", 24_700, "CE", NOW, 5)).toBeNull();
  });

  it("keeps calls and puts separate", () => {
    expect(master.nearestOption("NIFTY", 24_500, "PE", NOW)?.optionType).toBe(
      "PE",
    );
  });
});

describe("lot arithmetic — the sizing guardrails", () => {
  it("rounds DOWN to whole lots, never up", () => {
    // Up would spend more than the risk limit permitted, which is the one
    // direction a sizing function must never err in.
    expect(floorToLots(500, 65)).toBe(455); // 7 lots
    expect(floorToLots(455, 65)).toBe(455); // exact
    expect(floorToLots(64, 65)).toBe(0); // one lot does not fit
  });

  it("reports zero when a single lot is unaffordable", () => {
    // The caller must read 0 as "no capacity", not as a tiny order.
    expect(floorToLots(29, 30)).toBe(0);
  });

  it("computes notional per lot, which is NOT a future's cost", () => {
    // 65 × 24,500 ≈ ₹15.9 lakh notional on roughly ₹1.2 lakh of margin —
    // the gap that makes `capital / price` wrong for futures.
    const niftyFuture = {
      symbol: "NSE:NIFTY26AUGFUT",
      kind: "FUTURE" as const,
      lotSize: 65,
      tickSize: 0.05,
      underlying: "NIFTY",
      expiry: NEAR,
    };
    expect(notionalPerLot(niftyFuture, 24_500)).toBe(1_592_500);
  });
});
