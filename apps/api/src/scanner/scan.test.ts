import { describe, expect, it } from "vitest";
import { istDateKey, isWeekendIST, type Candle } from "@neelkanth/core";
import {
  BAN_LIST_NOT_CHECKED,
  previousTradingDay,
  runScan,
  type ScanRequest,
} from "./scan.js";
import type { UniverseMember } from "./universe.js";

const DAY = 86_400_000;
/** Tuesday 2026-11-17; its data day is Monday 2026-11-16. */
const SCAN_DATE = "2026-11-17";
const DATA_DAY_TS = Date.UTC(2026, 10, 16);

const member = (underlying: string, kind: "INDEX" | "STOCK" = "STOCK") => ({
  underlying,
  kind,
  symbol: kind === "INDEX" ? `NSE:${underlying}-INDEX` : `NSE:${underlying}-EQ`,
  future: `NSE:${underlying}26NOVFUT`,
  expiry: Date.UTC(2026, 10, 24),
  lotSize: 100,
});

/**
 * `count` daily bars on weekdays, ending on `lastTs`, stamped as FYERS stamps
 * resolution "D": 00:00 UTC of the IST date. Flat at 100 with real volume.
 */
function series(
  symbol: string,
  count: number,
  lastTs = DATA_DAY_TS,
  fields: Partial<Candle> = {},
): Candle[] {
  const bars: Candle[] = [];
  for (let ts = lastTs; bars.length < count; ts -= DAY) {
    if (isWeekendIST(istDateKey(ts))) continue;
    bars.unshift({
      symbol,
      interval: "1d",
      source: "BROKER_HISTORICAL",
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
      volumeAvailable: true,
      volumeQuality: "REAL",
      ts,
      ...fields,
    });
  }
  return bars;
}

/** The same series with a breakout on the last bar: above every prior high, on 5x volume. */
function breakout(symbol: string, fields: Partial<Candle> = {}): Candle[] {
  const bars = series(symbol, 40, DATA_DAY_TS, fields);
  const last = bars.at(-1);
  if (last === undefined) throw new Error("empty series");
  bars[bars.length - 1] = {
    ...last,
    open: 100,
    high: 111,
    low: 100,
    close: 110,
    volume: 5_000,
  };
  return bars;
}

const request = (
  members: UniverseMember[],
  bars: [string, Candle[]][],
  extra: Partial<ScanRequest> = {},
): ScanRequest => ({
  scanDate: SCAN_DATE,
  members,
  barsBySymbol: new Map(bars),
  ...extra,
});

describe("the pre-open scan (18.3)", () => {
  it("selects an instrument on which a condition held on the data day, with its evidence and data time", () => {
    const { result } = runScan(
      request(
        [member("RELIANCE")],
        [["NSE:RELIANCE-EQ", breakout("NSE:RELIANCE-EQ")]],
      ),
    );
    expect(result.dataDate).toBe("2026-11-16");
    expect(result.rejected).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const [candidate] = result.candidates;
    expect(candidate).toMatchObject({
      underlying: "RELIANCE",
      symbol: "NSE:RELIANCE-EQ",
      future: "NSE:RELIANCE26NOVFUT",
      dataTime: DATA_DAY_TS,
      close: 110,
      bias: "BULLISH",
    });
    expect(candidate?.held).toContainEqual({
      patternId: "HIGH_VOLUME_BREAKOUT",
      detectorVersion: "1.0.0",
      direction: "BULLISH",
      evidence: {
        close: 110,
        priorHigh: 101,
        priorLow: 99,
        volume: 5_000,
        averageVolume: 1_000,
      },
    });
    expect(candidate?.verdicts["HIGH_VOLUME_BREAKOUT"]).toBe("HELD");
  });

  it("rejects, with every condition's verdict, an instrument on which none held", () => {
    const { result } = runScan(
      request([member("INFY")], [["NSE:INFY-EQ", series("NSE:INFY-EQ", 40)]]),
    );
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([
      {
        underlying: "INFY",
        symbol: "NSE:INFY-EQ",
        reason: "NO_CONDITION",
        detail:
          "EMA_CROSS did not hold; HIGH_VOLUME_BREAKOUT did not hold; RSI_REVERSION did not hold",
        dataTime: DATA_DAY_TS,
        verdicts: {
          EMA_CROSS: "NOT_HELD",
          HIGH_VOLUME_BREAKOUT: "NOT_HELD",
          RSI_REVERSION: "NOT_HELD",
        },
      },
    ]);
  });

  it("names missing and stale data rather than judging what is not there", () => {
    const { result } = runScan(
      request(
        [member("ABC"), member("OLD")],
        [["NSE:OLD-EQ", series("NSE:OLD-EQ", 40, Date.UTC(2026, 10, 13))]],
      ),
    );
    expect(result.rejected).toEqual([
      {
        underlying: "ABC",
        symbol: "NSE:ABC-EQ",
        reason: "NO_BARS",
        detail: "no daily bars stored for NSE:ABC-EQ",
        dataTime: null,
        verdicts: {},
      },
      {
        underlying: "OLD",
        symbol: "NSE:OLD-EQ",
        reason: "STALE_DATA",
        detail: "its latest daily bar is 2026-11-13, not 2026-11-16",
        dataTime: Date.UTC(2026, 10, 13),
        verdicts: {},
      },
    ]);
    expect(result.partialBecause).toContain(
      "2 of 2 member(s) had no daily bar for 2026-11-16",
    );
  });

  it("says when no condition could judge: too few bars, or volume nobody trusts", () => {
    const { result } = runScan(
      request(
        [member("NEW"), member("NIFTYX", "INDEX")],
        [
          ["NSE:NEW-EQ", series("NSE:NEW-EQ", 5)],
          [
            "NSE:NIFTYX-INDEX",
            breakout("NSE:NIFTYX-INDEX", { volumeQuality: "SUSPECT" }),
          ],
        ],
      ),
    );
    const [fresh] = result.rejected;
    expect(fresh).toMatchObject({
      underlying: "NEW",
      reason: "NOT_JUDGEABLE",
      verdicts: {
        EMA_CROSS: "WARMING_UP",
        HIGH_VOLUME_BREAKOUT: "WARMING_UP",
        RSI_REVERSION: "WARMING_UP",
      },
    });
    // The index still breaks out on price; only the volume condition declines.
    const index = result.candidates.find((c) => c.underlying === "NIFTYX");
    expect(index?.verdicts["HIGH_VOLUME_BREAKOUT"]).toBe("VOLUME_NOT_TRUSTED");
    expect(index?.held.map((h) => h.patternId)).not.toContain(
      "HIGH_VOLUME_BREAKOUT",
    );
  });

  it("is PARTIAL while the ban list is unchecked, and records the universe's own rejections", () => {
    const universeRejected = [
      {
        underlying: "GONE",
        reason: "NO_ELIGIBLE_CONTRACT" as const,
        detail: "every listed future has expired",
      },
    ];
    const { result } = runScan(
      request([member("INFY")], [["NSE:INFY-EQ", series("NSE:INFY-EQ", 40)]], {
        universeRejected,
      }),
    );
    expect(result.status).toBe("PARTIAL");
    expect(result.partialBecause).toEqual([BAN_LIST_NOT_CHECKED]);
    expect(result.universeRejected).toEqual(universeRejected);
    expect(result.counts).toEqual({
      members: 1,
      candidates: 0,
      rejected: {
        NO_BARS: 0,
        STALE_DATA: 0,
        NOT_JUDGEABLE: 0,
        NO_CONDITION: 1,
      },
      universeRejected: 1,
    });
  });

  it("cannot see the scan day or after it", () => {
    const today = series("NSE:INFY-EQ", 40, Date.UTC(2026, 10, 17));
    expect(() =>
      runScan(request([member("INFY")], [["NSE:INFY-EQ", today]])),
    ).toThrow(/cannot see its own day or later/);
  });

  it("refuses intraday bars and a scan day the exchange is shut", () => {
    const fiveMinute = series("NSE:INFY-EQ", 40).map((b) => ({
      ...b,
      interval: "5m" as const,
    }));
    expect(() =>
      runScan(request([member("INFY")], [["NSE:INFY-EQ", fiveMinute]])),
    ).toThrow(/judges daily bars only/);
    expect(() =>
      runScan({ ...request([], []), scanDate: "2026-11-15" }),
    ).toThrow(/not a trading day/);
  });

  it("is the same scan, to the fingerprint, whatever order the members come in", () => {
    const members = [member("RELIANCE"), member("INFY"), member("ABC")];
    const bars: [string, Candle[]][] = [
      ["NSE:RELIANCE-EQ", breakout("NSE:RELIANCE-EQ")],
      ["NSE:INFY-EQ", series("NSE:INFY-EQ", 40)],
    ];
    const a = runScan(request(members, bars));
    const b = runScan(request([...members].reverse(), [...bars].reverse()));
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.result.rejected.map((r) => r.underlying)).toEqual(["ABC", "INFY"]);
  });
});

describe("the data day", () => {
  it("is the last trading day before the scan day, over weekends and holidays", () => {
    const none = new Set<string>();
    expect(previousTradingDay("2026-11-17", none, none)).toBe("2026-11-16");
    expect(previousTradingDay("2026-11-16", none, none)).toBe("2026-11-13");
    expect(
      previousTradingDay("2026-11-11", new Set(["2026-11-10"]), none),
    ).toBe("2026-11-09");
    // A Sunday special session (Muhurat, 2026-11-08) is a data day.
    expect(
      previousTradingDay("2026-11-09", none, new Set(["2026-11-08"])),
    ).toBe("2026-11-08");
  });
});
